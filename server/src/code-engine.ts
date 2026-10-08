/**
 * The code engine: a Parallel-style research loop whose only tool is
 * `run_code`. It exists as a separate engine, not a mode of the classic loop,
 * because the classic loop is built around tool-calling assumptions — batched
 * `web_search`/`fetch_url` tasks, a research ledger, wrap-up counters tuned to
 * tool calls — and the two architectures measured as hostile inside one
 * process: offered both paths, the model called `run_code` zero times in two
 * live runs.
 *
 * Shared spine, not shared loop: budget counters, source numbering, the
 * evidence store, checkpoints, tracing, the model transport and the v1 report
 * are the same modules the classic engine uses. Selection is
 * `sandbox.enabled`, and when this engine is selected the classic tools are not
 * in the tool list at all.
 */
import { callLLMStream, stripThinkingTags, type LLMRole } from './llm.js';
import { getCodeSystemPrompt } from './agent/code-prompt.js';
import { responseLengthBlock } from './agent/prompts.js';
import { RUN_CODE_TOOL, type EngineEvent, type ResearchRunOptions, type SourceWithIndex } from './engine/types.js';
import { createSandboxHandlers } from './engine/sandbox-handlers.js';
import { exportSandboxState, hydrateSandbox, runInSandbox } from './sandbox/manager.js';
import { deleteResearchCheckpoint, loadResearchCheckpoint, saveResearchCheckpoint } from './engine/checkpoint.js';

import { sanitizeHistory, temperatureForRound } from './engine/history.js';
import { sanitizeResearchAnswer, toPublicSource } from './engine/sources.js';
import { traceEvent } from './trace.js';
import { getConfig } from './config/load.js';
import {
  budgetSnapshot,
  chargeCpuMs,
  chargeUsage,
  checkCeilings,
  evidenceFloorDeficit,
  evidenceFloorMessage,
  remainingFetchCalls,
  remainingSearchCalls,
  CODE_FETCH_RETIRED_MESSAGE,
  CODE_SEARCH_RETIRED_MESSAGE,
  ANSWER_WINDOW_MESSAGE,
  answerWindowReserved,
  callDeadlineMs,
  createBudgetState,
  DEFAULT_RESEARCH_MODE,
  DEFAULT_RESPONSE_LENGTH,
  reasoningEffortForMode,
  resolveResearchPreset,
  modeBehaviorBlock,
  shouldWrapUp,
  WRAP_UP_MESSAGE,
  type BudgetState,
  type ReasoningEffort,
  type ResearchMode,
} from './engine/modes.js';
import type { AgentStep, SearchResponse, Source } from './schemas.js';
import type { ResearchPlan } from './engine/plan-tools.js';

interface LLMMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id?: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface AssistantChoice {
  message?: {
    content?: string | null;
    tool_calls?: { id?: string; function: { name: string; arguments: string } }[];
  };
  finish_reason?: string;
}

export async function runCodeResearchStream(
  query: string,
  history: { role: string; content: string }[] | undefined,
  onEvent: (event: EngineEvent) => void,
  mode: ResearchMode = DEFAULT_RESEARCH_MODE,
  options: ResearchRunOptions = {},
): Promise<void> {
  const preset = options.preset ?? resolveResearchPreset(mode);
  const reasoningEffort: ReasoningEffort = reasoningEffortForMode(preset.mode);
  const start = performance.now();
  const traceId = options.jobId;
  const sandboxKey = options.jobId ?? 'sandbox';

  if (traceId) {
    traceEvent(traceId, 'run.start', {
      query,
      engine: 'code',
      mode: preset.mode,
      reasoning_effort: reasoningEffort,
      verbosity: options.verbosity ?? null,
      response_length: options.responseLength ?? null,
      research_api: Boolean(options.researchApi),
      ceilings: {
        max_steps: preset.maxSteps, max_billable_tokens: preset.maxBillableTokens,
        max_search: preset.maxSearchCalls, max_fetch: preset.maxFetchCalls,
        max_wall_clock_ms: preset.maxWallClockMs,
        min_independent_sources: preset.minIndependentSources,
      },
    }, 0);
  }

  const steps: AgentStep[] = [];
  const allSources = new Map<string, SourceWithIndex>();
  const budget: BudgetState = createBudgetState();
  /* Plan and decline state for the sandbox RPC functions. Owned here, read by
     the handlers; the classic loop keeps the equivalent in its own scope. */
  const codePlanRef: { current: ResearchPlan | null } = { current: null };
  const declinedRef: { reason: string | null } = { reason: null };

  let startRound = 0;
  if (options.jobId) {
    const checkpoint = loadResearchCheckpoint(options.jobId);
    if (checkpoint && checkpoint.preset.mode === preset.mode) {
      Object.assign(budget, checkpoint.budget);
      budget.usedTotalTokens ??= 0;
      budget.usedCpuMs ??= 0;
      budget.startedAt = Date.now() - (Date.now() - budget.startedAt);
      startRound = checkpoint.round;
      for (const source of checkpoint.sourceMap) allSources.set(source.url, source);
      const resumeStep: AgentStep = {
        type: 'checkpoint',
        note: `Resumed from checkpoint at round ${startRound} (${allSources.size} sources, sandbox state ${checkpoint.sandboxState ? 'restored' : 'empty'}).`,
      };
      steps.push(resumeStep);
      onEvent({ type: 'step', data: resumeStep });
      /* The checkpoint carries the model's explicit `state`; interpreter
         globals outside it are gone, and pages come back with read_source (D4).
         Handlers are placeholders until the first round installs live ones. */
      if (checkpoint.sandboxState) {
        const notReady = async () => ({ error: 'Sandbox handlers are not ready yet.' });
        hydrateSandbox(options.jobId, {
          search: notReady,
          extract: notReady,
          read_source: notReady,
          plan: notReady,
          plan_update: notReady,
          plan_read: notReady,
          budget: notReady,
          decline: notReady,
        }, checkpoint.sandboxState);
      }
      if (traceId) traceEvent(traceId, 'note', { resumed: true, start_round: startRound }, startRound);
    }
  }

  const now = new Date();
  const today = `${now.toLocaleDateString('en-US', { month: 'long' })} ${now.getDate()}, ${now.getFullYear()}`;
  const resumeBlock = startRound > 0
    ? `\n\n**Resume:** This job resumed from round ${startRound}. Your \`state\` was restored; use the cited sources and do not repeat completed research unless a gap reopened.`
    : '';
  const stableSystemPrompt = getCodeSystemPrompt()
    + `\n\n**Today's date:** ${today}.`
    + responseLengthBlock(options.responseLength ?? DEFAULT_RESPONSE_LENGTH)
    + resumeBlock
    + modeBehaviorBlock(preset, 'extract', options.planningEnabled !== false);
  /* The provider serves a repeated system prompt from its prompt cache, and a
     cached first turn comes back without a tool call. Measured 2026-10-02 on
     byte-identical requests: cold -> run_code, cached -> an answer from model
     memory, while classic requests stayed healthy under the same cache and
     later rounds stayed healthy when cached. A per-job marker on the first
     request only keeps that turn cold; round 1 onward uses the stable prompt
     so the rest of the run can cache. */
  const coldStartBlock = startRound === 0 ? `<!-- request ${sandboxKey} -->\n\n` : '';
  const systemPrompt = coldStartBlock + stableSystemPrompt;
  if (traceId) traceEvent(traceId, 'prompt.assembled', { engine: 'code', system_prompt: systemPrompt, response_length: options.responseLength ?? DEFAULT_RESPONSE_LENGTH }, 0);

  const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];
  const sanitizedHistory = sanitizeHistory(history, query);
  if (sanitizedHistory.length > 0) messages.push(...sanitizedHistory.map(h => ({ role: h.role, content: h.content })));
  messages.push({ role: 'user', content: query });

  const activeRole: LLMRole = preset.mode;
  const publishSources = (): void => onEvent({ type: 'sources', sources: Array.from(allSources.values()).map(toPublicSource) });
  /* Without this the runner never learns the budget: no live progress, no
     terminal billing, no pauseable runtime. The classic loop publishes the
     same shape; the runner cannot tell the engines apart. */
  const publishProgress = (): void => {
    options.onProgress?.({
      budget: budgetSnapshot(budget, preset),
      budgetState: { ...budget },
      round,
      mode: preset.mode,
      sourceMap: Array.from(allSources.values()),
    });
  };
  const maxTotalTurns = getConfig().research.maxTotalTurns;

  let round = startRound;
  let totalTurns = 0;
  let totalToolCalls = 0;
  let wrapUpWarned = false;
  let answerWindowAnnounced = false;
  let retiredSearchNotified = false;
  let retiredFetchNotified = false;
  let emptyCompletionRetried = false;
  let answer: string | null = null;

  while (totalTurns < maxTotalTurns) {
    /* Round 0 keeps the cold-start marker; from round 1 the stable prompt
       replaces it in place, so the prefix can cache for the rest of the run. */
    messages[0] = { role: 'system', content: round === 0 ? coldStartBlock + stableSystemPrompt : stableSystemPrompt };
    if (options.signal?.aborted) return;
    budget.usedTurns = totalTurns;

    const ceiling = checkCeilings(budget, preset);
    if (ceiling && !budget.exhaustedBy) {
      /* Mirror of the classic loop: hard ceilings and both allowances out end
         the run, but one spent allowance only retires its own capability. The
         code loop used to force the answer on any ceiling, so a search-heavy
         run died with its fetch allowance untouched. */
      const hardCeiling = ceiling === 'wall_clock' || ceiling === 'steps' || ceiling === 'tokens';
      const bothOut = remainingSearchCalls(budget, preset) <= 0 && remainingFetchCalls(budget, preset) <= 0;
      if (hardCeiling || bothOut) {
        budget.exhaustedBy = ceiling;
        const snapshot = budgetSnapshot(budget, preset);
        const limitStep: AgentStep = {
          type: 'budget',
          note: `Research stopped: ${ceiling} ceiling reached (${snapshot.used_search_calls}/${snapshot.search_calls_limit} searches, ${snapshot.used_fetch_calls}/${snapshot.fetch_calls_limit} page reads, ${snapshot.elapsed_ms}ms).`,
        };
        steps.push(limitStep);
        onEvent({ type: 'step', data: limitStep });
        messages.push({
          role: 'user',
          content: `Your research budget is exhausted (${ceiling} limit reached). Write the final answer now using the evidence already gathered, and state explicitly what could not be confirmed.`,
        });
      } else if (ceiling === 'search_calls' && !retiredSearchNotified) {
        retiredSearchNotified = true;
        messages.push({ role: 'user', content: CODE_SEARCH_RETIRED_MESSAGE });
        if (traceId) traceEvent(traceId, 'note', { tool_retired: 'search' }, round);
      } else if (ceiling === 'fetch_calls' && !retiredFetchNotified) {
        retiredFetchNotified = true;
        messages.push({ role: 'user', content: CODE_FETCH_RETIRED_MESSAGE });
        if (traceId) traceEvent(traceId, 'note', { tool_retired: 'extract' }, round);
      }
    }

    const forceAnswer = budget.exhaustedBy !== null || totalToolCalls >= preset.forceAnswerToolCalls;
    /* Same rule as the classic loop: once what is left of the wall clock is the
       answer's window, stop researching rather than discover at the deadline
       that there is no time left to write. */
    const answerWindow = !forceAnswer
      && answerWindowReserved(budget, preset, options.responseLength ?? DEFAULT_RESPONSE_LENGTH);
    if (answerWindow && !answerWindowAnnounced) {
      answerWindowAnnounced = true;
      messages.push({ role: 'user', content: ANSWER_WINDOW_MESSAGE });
      if (traceId) traceEvent(traceId, 'note', { answer_window: true }, round);
    }
    if (forceAnswer && budget.exhaustedBy === null) {
      messages.push({
        role: 'user',
        content: 'The research tool-call limit has been reached. Write the final answer to the original request using the evidence already gathered, with inline [N] citations and explicit unresolved gaps.',
      });
    }
    if (!forceAnswer && !wrapUpWarned && shouldWrapUp(budget, preset, totalToolCalls)) {
      messages.push({ role: 'user', content: WRAP_UP_MESSAGE });
      wrapUpWarned = true;
    }

    const tools = forceAnswer ? undefined : [RUN_CODE_TOOL];
    if (traceId) {
      traceEvent(traceId, 'round.start', {
        engine: 'code',
        turn: totalTurns,
        force_answer: forceAnswer,
        tools: tools ? ['run_code'] : [],
        budget: {
          used_steps: budget.usedSteps, used_tokens: budget.usedTokens,
          used_search: budget.usedSearchCalls, used_fetch: budget.usedFetchCalls,
          exhausted_by: budget.exhaustedBy,
        },
      }, round);
    }

    let llmResult;
    try {
      llmResult = await callLLMStream({
        messages,
        temperature: temperatureForRound(round),
        tools,
        toolChoice: tools ? 'auto' : 'none',
        role: activeRole,
        signal: options.signal,
        reasoningEffort,
        responseLength: options.responseLength ?? DEFAULT_RESPONSE_LENGTH,
        finalAnswer: forceAnswer,
        /* The job's remaining promise, minus the answer's window. The transport
           adds nothing of its own except the idle timer, which watches silence. */
        deadlineMs: callDeadlineMs(budget, preset, options.responseLength ?? DEFAULT_RESPONSE_LENGTH, forceAnswer),
        traceId,
        traceRound: round,
        label: `code-round-${round}`,
      });
    } catch (error) {
      onEvent({ type: 'error', message: error instanceof Error ? error.message : 'No available model responded' });
      return;
    }

    chargeUsage(budget, llmResult.usage, llmResult.provider, llmResult.model);

    const data = llmResult.data as { choices?: AssistantChoice[] } | undefined;
    const choice = data?.choices?.[0];
    if (!choice) {
      onEvent({ type: 'error', message: 'Model response contains no choices.' });
      return;
    }
    const content = choice.message?.content ? stripThinkingTags(choice.message.content) : null;
    const toolCalls = Array.isArray(choice.message?.tool_calls) ? choice.message!.tool_calls! : [];

    if (toolCalls.length === 0) {
      if (typeof content === 'string' && content.trim()) {
        /* Same mechanical floor as the classic loop: pages read plus a closed
           plan, bypassed once a ceiling forces the answer. */
        if (!forceAnswer) {
          const pending = codePlanRef.current?.items.filter((i) => i.status === 'pending').length ?? 0;
          const deficit = evidenceFloorDeficit(budget, preset, pending);
          if (deficit) {
            messages.push({ role: 'user', content: evidenceFloorMessage(preset, deficit) });
            if (traceId) {
              traceEvent(traceId, 'note', { evidence_floor: deficit, exhausted_by: budget.exhaustedBy }, round);
            }
            budget.usedSteps++;
            totalTurns++;
            publishProgress();
            continue;
          }
        }
        answer = content;
        break;
      }
      if (!emptyCompletionRetried) {
        emptyCompletionRetried = true;
        /* A degenerate completion is worth one retry of the same round,
           because the provider leaked the Qwen end-of-turn token as the only
           output: `<|im_end|>` in the reasoning channel, one output token,
           finish_reason stop (`j-ECmX3PY8KZyG`). The run died one call from
           its answer. Nothing in the conversation changes on the retry. */
        if (traceId) {
          traceEvent(traceId, 'note', {
            engine: 'code', empty_completion_retry: true,
            finish_reason: choice.finish_reason ?? null,
            output_tokens: llmResult.usage.outputTokens,
          }, round);
        }
        continue;
      }
      onEvent({ type: 'error', message: `Model returned an empty completion (finish_reason: ${choice.finish_reason || 'unknown'}).` });
      return;
    }

    /* Narration is shown, never replayed: the next round works from the tool
       results, so the transcript stays append-only and cacheable. */
    const normalizedToolCalls = toolCalls.map((toolCall) => ({
      ...toolCall,
      id: toolCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    }));
    messages.push({ role: 'assistant', content: null, tool_calls: normalizedToolCalls });
    const handlers = createSandboxHandlers({
      allSources, budget, preset, round, traceId, signal: options.signal, publishSources,
      planRef: codePlanRef, declinedRef,
    });

    for (const toolCall of normalizedToolCalls) {
      const callId = toolCall.id;
      if (declinedRef.reason) {
        messages.push({ role: 'tool', tool_call_id: callId, content: 'Request declined; program skipped.' });
        continue;
      }
      if (toolCall.function.name !== 'run_code') {
        messages.push({ role: 'tool', tool_call_id: callId, content: `Unknown tool ${toolCall.function.name}. run_code is the only available tool.` });
        continue;
      }
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ ok: false, error: 'Arguments are not valid JSON.' }) });
        continue;
      }
      const code = typeof args.code === 'string' ? args.code : '';
      if (!code.trim()) {
        messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ ok: false, error: 'run_code needs a non-empty code string.' }) });
        continue;
      }
      const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim().slice(0, 80) : 'program';
      if (traceId) traceEvent(traceId, 'tool.call', { tool: 'run_code', label, code_chars: code.length, call_id: callId }, round);

      const step: AgentStep = { type: 'code', query: label };
      steps.push(step);
      onEvent({ type: 'step', data: step });
      const startedCode = performance.now();
      const result = await runInSandbox(sandboxKey, handlers, code, options.signal);
      step.duration_ms = Math.round(performance.now() - startedCode);
      /* Execution time is metered wall-clock per program (D6). A timed-out run
         still burned the interpreter until the kill. */
      chargeCpuMs(budget, performance.now() - startedCode);
      step.note = result.timedOut
        ? `Program timed out after ${getConfig().sandbox.timeoutMs}ms`
        : result.ok
          ? 'Program ran'
          : `Program failed: ${result.error ?? 'unknown error'}`;
      onEvent({ type: 'step', data: step });

      const payload = JSON.stringify({ ok: result.ok, value: result.value, stdout: result.stdout, ...(result.error ? { error: result.error } : {}) });
      const maxChars = getConfig().sandbox.maxOutputChars;
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: payload.length > maxChars ? `${payload.slice(0, maxChars)}... [clipped]` : payload,
      });
      totalToolCalls++;
      if (traceId) {
        traceEvent(traceId, 'code.result', {
          label, ok: result.ok, timed_out: Boolean(result.timedOut),
          value_chars: result.value.length, stdout_chars: result.stdout.length, error: result.error ?? null,
        }, round);
      }
    }

    if (declinedRef.reason) {
      onEvent({ type: 'declined', reason: declinedRef.reason });
      if (traceId) {
        traceEvent(traceId, 'run.end', {
          engine: 'code',
          outcome: 'declined',
          reason: declinedRef.reason,
          rounds: round + 1,
          total_turns: totalTurns,
          total_tool_calls: totalToolCalls,
          tokens_used: budget.usedTokens,
          exhausted_by: budget.exhaustedBy,
          sources: allSources.size,
          elapsed_ms: Math.round(performance.now() - start),
        }, round);
      }
      return;
    }

    round++;
    totalTurns++;
    budget.usedSteps++;
    publishSources();
    publishProgress();

    if (options.jobId && preset.checkpointEverySteps > 0 && budget.usedSteps % preset.checkpointEverySteps === 0) {
      saveResearchCheckpoint({
        jobId: options.jobId,
        query,
        preset,
        budget: { ...budget },
        reasoningEffort,
        verbosity: options.verbosity,
        researchApi: options.researchApi,
        round,
        sourceMap: Array.from(allSources.values()),
        sandboxState: await exportSandboxState(options.jobId),
        lastUpdatedAt: new Date().toISOString(),
      });
      const checkpointStep: AgentStep = { type: 'checkpoint', note: `Checkpoint saved at round ${round}.` };
      steps.push(checkpointStep);
      onEvent({ type: 'step', data: checkpointStep });
    }
  }

  const finalSources: Source[] = Array.from(allSources.values()).map(toPublicSource);
  if (traceId) {
    traceEvent(traceId, 'run.end', {
      engine: 'code',
      outcome: answer ? 'answered' : 'no_answer',
      answer_chars: answer?.length ?? 0,
      rounds: round + 1,
      total_turns: totalTurns,
      total_tool_calls: totalToolCalls,
      tokens_used: budget.usedTokens,
      token_limit: preset.maxBillableTokens,
      exhausted_by: budget.exhaustedBy,
      sources: allSources.size,
      elapsed_ms: Math.round(performance.now() - start),
    });
  }

  if (answer) {
    const elapsed = Math.round(performance.now() - start);
    const sanitizedAnswer = sanitizeResearchAnswer(answer, finalSources);
    if (options.jobId) deleteResearchCheckpoint(options.jobId);
    onEvent({ type: 'context', finalContext: JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })).filter(m => typeof m.content === 'string' && m.content.length > 0)) });

    const responseBase = {
      query,
      answer: sanitizedAnswer,
      sources: finalSources,
      steps,
      results_count: allSources.size,
      elapsed_ms: elapsed,
      research_budget: budgetSnapshot(budget, preset),
      mode: preset.mode,
      reasoning_effort: reasoningEffort,
      verbosity: options.verbosity,
    };

    if (options.researchApi) {
      onEvent({ type: 'done', response: responseBase as SearchResponse });
      return;
    }

    onEvent({ type: 'done', response: responseBase as SearchResponse });
    return;
  }

  onEvent({
    type: 'error',
    message: allSources.size > 0
      ? (budget.exhaustedBy !== null ? 'Research budget exhausted but the model produced no answer.' : 'Model used all rounds but produced no answer.')
      : 'Model could not produce an answer.',
  });
}
