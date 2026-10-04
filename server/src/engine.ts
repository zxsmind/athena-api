import { callLLMStream, extractThinkBlockText, stripThinkingTags, type LLMRole } from './llm.js';
import type { LLMResult } from './llm.js';
import { searchResults, extractPageContent } from './search/index.js';
import type { SearchResponse, Source, AgentStep } from './schemas.js';
import type { SearchResult } from './schemas.js';
import { getDeepSystemPrompt, responseLengthBlock } from './agent/prompts.js';
import { getApiResearchSystemPrompt } from './agent/research-api-prompt.js';
import { loadSettings } from './settings-store.js';
import { createSearchTool, fetchResultsKey, DECLINE_REQUEST_TOOL, DECLINE_REQUEST_TOOL_NAME, FETCH_URL_TOOL, MAX_URLS_PER_FETCH_CALL, READ_BUDGET_TOOL, READ_BUDGET_TOOL_NAME, type EngineEvent, type ResearchRunOptions, type SourceWithIndex } from './engine/types.js';
import { closeSandbox } from './sandbox/manager.js';
import { runCodeResearchStream } from './code-engine.js';
import { CREATE_PLAN_TOOL, EDIT_PLAN_TOOL, READ_PLAN_TOOL, planForModel, planSummary, validatePlanEditItems, type PlanReadArgs, type ResearchPlan } from './engine/plan-tools.js';
import { temperatureForRound, sanitizeHistory, domain } from './engine/history.js';
import { parseInlineToolCall } from './engine/tool-parser.js';
import { usesInlineToolCalls } from './provider-registry.js';
import { deleteResearchCheckpoint, loadResearchCheckpoint, saveResearchCheckpoint } from './engine/checkpoint.js';
import {
  modeBehaviorBlock,
  budgetSnapshot,
  chargeFetchCalls,
  chargeSearchCalls,
  chargeUsage,
  checkCeilings,
  createBudgetState,
  DEFAULT_RESEARCH_MODE,
  DEFAULT_RESPONSE_LENGTH,
  budgetReadingForModel,
  evidenceFloorDeficit,
  evidenceFloorMessage,
  remainingFetchCalls,
  remainingSearchCalls,
  reasoningEffortForMode,
  resolveResearchPreset,
  shouldWrapUp,
  WRAP_UP_MESSAGE,
  SEARCH_RETIRED_MESSAGE,
  FETCH_RETIRED_MESSAGE,
  type StopReason,
  type BudgetState,
  type ReasoningEffort,
  type ResearchMode,
  type ResearchPreset,
  type ResponseLength,
} from './engine/modes.js';
import { buildReportForRun } from './engine/report-run.js';
import type { DeepResearchState } from './engine/context-blocks.js';
import {
  REPORT_PROGRESS_RESULT,
  REPORT_PROGRESS_TOOL,
  REPORT_PROGRESS_TOOL_NAME,
  progressNoteFrom,
  type ProgressNote,
} from './engine/progress.js';
import { traceEvent, traceLive } from './trace.js';
import { RECALL_SOURCE_TOOL, recallSource, storeEvidence, type RecallSourceArgs } from './engine/evidence-store.js';
import { isContextOverflow } from './engine/triggers.js';
import { runCompactionTier, runRecallClear } from './engine/compaction.js';
import { formatResultLine, sanitizeResearchAnswer, toPublicSource } from './engine/sources.js';
import { getConfig } from './config/load.js';
import { withRetry } from './engine/retry.js';
import {
  createResearchLedger,
  duplicateFetchToolMessage,
  duplicateSearchToolMessage,
  findPriorFetch,
  findPriorSearch,
  recordLedgerFetch,
  recordLedgerSearch,
} from './engine/research-ledger.js';

export type { EngineEvent, ResearchRunOptions } from './engine/types.js';

interface LLMMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id?: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** The model's deliberation for this turn. Never stripped: it rides along
    for the next round so thinking models keep their thread. */
  reasoning?: string | null;
}

function makeFinalContextJson(messages: LLMMessage[]): string {
  const all = messages.map(m => ({ role: m.role, content: m.content })).filter((m): m is { role: string; content: string } => typeof m.content === 'string' && m.content.length > 0);
  return JSON.stringify(all);
}

/* Progress is available on every research run because it describes the run
   rather than any research store. */
const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set(['create_plan', 'edit_plan', 'read_plan']);
const LOCAL_TOOL_NAMES = new Set([...PLAN_TOOL_NAMES, 'recall_source', REPORT_PROGRESS_TOOL_NAME, READ_BUDGET_TOOL_NAME, DECLINE_REQUEST_TOOL_NAME]);

/**
 * Decides what a progress step shows for the requested verbosity.
 *
 * The note is the model's own words about the step: its text if it sent any,
 * otherwise its reasoning. reasoning is the model's raw reasoning output and is
 * reported only for detailed/max, and only when it is not the same string as
 * the note. An absent verbosity behaves like detailed, preserving the
 * long-standing behavior of showing reasoning.
 *
 * This governs only the consumer-facing step event. Diagnostics keep
 * everything: the trace and live log always record reasoning regardless of
 * verbosity.
 */
export function stepContentForVerbosity(input: {
  text: unknown;
  reasoning: unknown;
  verbosity: string | undefined;
}): { note: string | null; reasoning: string | null } {
  const text = typeof input.text === 'string' && input.text.trim() ? input.text.trim() : null;
  const reasoning = typeof input.reasoning === 'string' && input.reasoning.trim() ? input.reasoning.trim() : null;
  /* The note is whatever the model said about this step. Providers that send no
     text alongside a tool call put the whole thought in the reasoning field, so
     the note falls back to it instead of leaving the step blank. */
  const note = text ?? reasoning;
  if (input.verbosity === 'summary') {
    return { note, reasoning: null };
  }
  /* Not repeated: when the note already is the reasoning, reporting it in both
     fields would show the same paragraph twice. */
  const separate = reasoning !== null && reasoning !== note ? reasoning : null;
  return { note, reasoning: separate };
}

type RoundResult =
  | { kind: 'tools'; researchToolCalls: number }
  | { kind: 'answer' }
  | { kind: 'declined'; reason: string }
  | { kind: 'error' };

/* ── Core tool-calling round ── */
async function toolCallingRound(
  messages: LLMMessage[], allSources: Map<string, SourceWithIndex>,
  steps: AgentStep[], round: number, onEvent: (ev: EngineEvent) => void,
  budget: BudgetState, preset: ResearchPreset, onRoundProgress?: () => void,
  signal?: AbortSignal, role?: LLMRole, deepState?: DeepResearchState,
  forceAnswer?: boolean,
  planningEnabled = true,
  researchPlanRef?: { current: ResearchPlan | null },
  reasoningEffort?: ReasoningEffort,
  researchApi = false,
  traceId?: string,
  verbosity?: string,
  /* Loop iteration, unique per toolCallingRound invocation. `round` counts
     research rounds (it advances only when a search or fetch ran), so two
     invocations can share one round number; the turn tells them apart in the
     trace and in LLM labels. */
  turn?: number,
  /* Requested answer length, for output-side timeouts. The forced final
     answer is the run's largest output; the transport budgets it as one. */
  responseLength?: ResponseLength,
): Promise<RoundResult> {
  if (signal?.aborted) return { kind: 'error' };
  /* Only a failure buys a delay. A healthy run never waits. */
  const retryDelays = getConfig().research.retryDelaysMs;

  /* Keep the base system prompt and drop every later system message. Nothing is
     injected between rounds: the agent's own context is the conversation, and
     anything it needs — plan, sources — it reads with a tool call. */
  if (messages.length > 1) {
    const baseSystem = messages[0];
    const rest = messages.slice(1).filter(msg => msg.role !== 'system');
    messages.length = 0;
    messages.push(baseSystem, ...rest);
  }

  /* Window check before the call. Offload is mechanical and lossless (stubs +
     Evidence Store), so it runs before the model sees a prompt that might not
     fit, not after it fails. */
  if (deepState && traceId && getConfig().compaction.enabled) {
    runCompactionTier(messages, deepState, traceId, round, false);
    /* A recall last round proves the model needed something it could not see.
       Clear old rounds now, outside any threshold: the recalled text arrived
       this round and is never eligible for the pass it triggers. */
    if (deepState.recallPendingClear) {
      deepState.recallPendingClear = false;
      runRecallClear(messages, traceId, round);
    }
  }

  /* A round marker, not a thought. The note names the round factually; the
     model's real reasoning replaces it below when the response arrives. */
  const stepType = round === 0 ? 'plan-analyze' : 'analyze';
  const step: AgentStep = { type: stepType, note: `Round ${round + 1}` };
  steps.push(step);
  onEvent({ type: 'step', data: step });

  if (forceAnswer) {
    const warning = 'Research tools are disabled. Write the final answer to the original request using the evidence already gathered. Cite supported claims with [N] and explicitly mark unresolved gaps.';
    messages.push({ role: 'user', content: warning });
    onRoundProgress?.();
  }

  const temp = temperatureForRound(round);
  const tools = forceAnswer
    ? undefined
    : (() => {
        const searchTool = createSearchTool(getConfig().research.maxQueriesPerSearchCall);
        /* A spent allowance retires its tool from the list; the other stays
           while its own budget remains. */
        const baseTools = [
          ...(remainingSearchCalls(budget, preset) > 0 ? [searchTool] : []),
          ...(remainingFetchCalls(budget, preset) > 0 ? [FETCH_URL_TOOL] : []),
        ];
        const planTools = deepState && planningEnabled ? [CREATE_PLAN_TOOL, EDIT_PLAN_TOOL, READ_PLAN_TOOL] : [];
        const recallTools = deepState && traceId ? [RECALL_SOURCE_TOOL] : [];
        return [REPORT_PROGRESS_TOOL, READ_BUDGET_TOOL, DECLINE_REQUEST_TOOL, ...planTools, ...baseTools, ...recallTools];
      })();

  const toolNames = (tools ?? []).map((t) => {
    const fn = (t as { function?: { name?: string } }).function;
    return fn?.name ?? 'unknown';
  });
  if (traceId) {
    traceEvent(traceId, 'round.start', {
      turn: turn ?? null,
      force_answer: forceAnswer,
      tools: toolNames,
      budget: {
        used_steps: budget.usedSteps, used_tokens: budget.usedTokens,
        used_search: budget.usedSearchCalls, used_fetch: budget.usedFetchCalls,
        exhausted_by: budget.exhaustedBy,
      },
      plan: researchPlanRef?.current ? planSummary(researchPlanRef.current) : null,
    }, round);
  }

  const invokeOnce = async (): Promise<LLMResult> => {
    const result = await callLLMStream({
      messages, temperature: temp, tools, toolChoice: tools ? 'auto' : 'none', role, signal,
      reasoningEffort,
      responseLength,
      finalAnswer: forceAnswer ?? false,
      traceId,
      traceRound: round,
      onModelSelected: (selectedModel) => { step.model = selectedModel; onEvent({ type: 'step', data: step }); },
      label: turn === undefined ? `tool-round-${round}` : `tool-round-${round}t${turn}`,
      /* Token deltas stream from the provider but reach the consumer only off
         the API path. Forwarding every chunk as a job event would flood the
         per-job event store (`maxEventsPerJob`) and the SSE stream for no
         information the step events do not already carry: with `detailed`
         verbosity the step holds the note and the reasoning, and progress notes
         arrive as their own events. */
      onToken: (text: string) => { if (!researchApi) onEvent({ type: 'token', text }); },
    });
    /* Only provider-reported usage is recorded. A provider that returns no usage
       leaves the counters untouched rather than guessing a token count.

       Cache reads are excluded from the job ceiling. They re-read a prefix the
       provider already holds and are billed at a fraction of a fresh input
       token, so counting them at face value would stop a long research run for
       work it did not pay for. They are still recorded per model below, so
       billing sees the real cost. */
    if (result.usage.reported) {
      chargeUsage(budget, result.usage, result.provider, result.model);
      /* The serving model is remembered so the next round's window check uses
         a model that actually served this job, not just the configured one. */
      if (deepState && result.provider && result.model) {
        deepState.lastUsed = { providerId: result.provider, model: result.model };
      }
    }

    const d = result.data as { choices: { message: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; reasoning?: string; reasoning_content?: string }; finish_reason: string }[] } | undefined;
    const choice = d?.choices?.[0];
    if (!choice) {
      throw new Error('Model response contains no choices.');
    }
    const msg = choice.message;
    const cleanedContent = msg.content ? stripThinkingTags(msg.content) : null;
    const hasContent = typeof cleanedContent === 'string' && cleanedContent.trim().length > 0;
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (!hasContent && !hasToolCalls) {
      throw new Error(`Model returned an empty completion (finish_reason: ${choice.finish_reason || 'unknown'}).`);
    }
    return result;
  };

  /* A provider overflow gets exactly one emergency offload and one retry.
     Anything else, or a second overflow, ends the round visibly instead of
     looping. */
  let llmResult: LLMResult;
  let overflowRetried = false;
  let emptyRetried = false;
  for (;;) {
    try {
      llmResult = await invokeOnce();
      break;
    } catch (err: unknown) {
      if (!overflowRetried && deepState && traceId && getConfig().compaction.enabled && isContextOverflow(err)) {
        overflowRetried = true;
        const cleared = runCompactionTier(messages, deepState, traceId, round, true);
        traceEvent(traceId, 'note', {
          overflow_retry: true,
          cleared_anything: cleared,
          error: (err as Error).message,
        }, round);
        continue;
      }
      /* One retry when the provider leaks its end-of-turn token as the only
         output: a degenerate completion, not a real refusal. Measured on the
         code engine (`j-ECmX3PY8KZyG`); the same provider serves this loop. */
      const failure = err instanceof Error ? err.message : String(err);
      if (!emptyRetried && failure.includes('empty completion')) {
        emptyRetried = true;
        if (traceId) traceEvent(traceId, 'note', { empty_completion_retry: true, error: failure }, round);
        continue;
      }
      onEvent({ type: 'context', finalContext: makeFinalContextJson(messages) });
      onEvent({ type: 'error', message: (err as Error).message || 'No available model responded' });
      return { kind: 'error' };
    }
  }

  const { data, model } = llmResult;
  const d = data as { choices: { message: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; reasoning?: string; reasoning_content?: string }; finish_reason: string }[] } | undefined;
  const choice = d!.choices[0];
  const msg = choice.message;
  const rawContent = typeof msg.content === 'string' ? msg.content : null;
  if (msg.content) msg.content = stripThinkingTags(msg.content);
  const currentModel = model;
  const inlineAllowed = usesInlineToolCalls(
    llmResult.provider,
    currentModel,
    loadSettings().providers[llmResult.provider],
  );

  /* Reasoning is never deleted: dedicated fields plus embedded think blocks
     are all kept on the conversation for the next round. Stripping above is
     display-only for notes and answers. */
  const thinkText = rawContent ? extractThinkBlockText(rawContent) : null;
  const reasoningText = msg.reasoning || msg.reasoning_content || thinkText;
  const stated = stepContentForVerbosity({ text: msg.content, reasoning: reasoningText, verbosity });
  /* Only a tool round is a progress step. A reply without tool calls is the
     answer itself, so it never becomes a note. */
  if (msg.tool_calls && stated.note) step.note = stated.note;
  if (stated.reasoning) step.reasoning = stated.reasoning;
  step.model = currentModel;
  onEvent({ type: 'step', data: step });

  if (msg.tool_calls) {
    /* Narration is shown, never replayed: the next round works from the tool
       results, so the transcript stays append-only and cacheable. Reasoning
       is the exception: it rides along untouched. */
    msg.content = null;
    messages.push({ role: msg.role, content: null, tool_calls: msg.tool_calls, reasoning: reasoningText ?? null });

    const searchTasks: { tcId: string; query: string; type: string; stepIndex: number }[] = [];
    const fetchTasks: { tcId: string; url: string; stepIndex: number; key: string }[] = [];
    const recallTasks: { tcId: string; args: RecallSourceArgs }[] = [];
    /* Collected per round so the caller can count what the model published. Kept out
       of the task list, so a round whose only call is report_progress does not
       count as research and does not advance the wrap-up counters. */
    const publishedProgress: ProgressNote[] = [];
    let publishedProgressCalls = 0;
    /* Answered during collection (progress notes), so a terminal decline
       later in this round must not answer them twice. */
    const answeredTcIds = new Set<string>();
    const planCreateTasks: { tcId: string; args: { goal: string; items: { text: string }[] } }[] = [];
    const planEditTasks: { tcId: string; args: { goal?: string; items: { text: string; status: string; evidence?: unknown }[] } }[] = [];
    const planReadTasks: { tcId: string; args: PlanReadArgs }[] = [];
    /* Free reads, answered after the turn's charges. Kept out of the task
       list for the same reason as progress: a budget-only round is not
       research and does not advance the wrap-up counters. */
    const budgetReadTasks: { tcId: string }[] = [];
    const declineTasks: { tcId: string; reason: string }[] = [];
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown>;
      try { args = JSON.parse(tc.function.arguments); } catch { continue; }
      const tcId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      const toolCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    if (traceId) {
      traceEvent(traceId, 'tool.call', {
        tool: tc.function.name,
        arguments: args,
        call_id: tc.id ?? toolCallId,
      }, round);
      traceLive(traceId, `ROUND ${round} TOOL CALL ${tc.function.name}`, JSON.stringify(args, null, 2));
    }
    /* A progress note is published, not returned to the model. It never
         becomes a step and never reaches the tool channel, so the model cannot
         read back what the user saw. */
      if (tc.function.name === REPORT_PROGRESS_TOOL_NAME) {
        const note = progressNoteFrom(args, round);
        messages.push({ role: 'tool', tool_call_id: tcId, content: REPORT_PROGRESS_RESULT });
        answeredTcIds.add(tcId);
      publishedProgressCalls++;
        if (note) {
          publishedProgress.push(note);
          onEvent({ type: 'progress', data: { headline: note.headline, body: note.body, round } });
          if (traceId) {
            traceEvent(traceId, 'progress', { headline: note.headline, body: note.body, call_id: tc.id ?? toolCallId }, round);
            traceLive(traceId, `ROUND ${round} PROGRESS ${note.headline}`, note.body);
          }
        }
        continue;
      }

      if (!planningEnabled && PLAN_TOOL_NAMES.has(tc.function.name)) {
        messages.push({
          role: 'tool',
          tool_call_id: tcId,
          content: 'Planning tools are disabled for this run. Investigate the original request directly with the available research tools.',
        });
        if (traceId) traceEvent(traceId, 'tool.skipped', { tool: tc.function.name, reason: 'planning disabled' }, round);
        continue;
      }

      if (tc.function.name === 'create_plan') {
        planCreateTasks.push({ tcId, args: args as unknown as { goal: string; items: { text: string }[] } });
        continue;
      }

      if (tc.function.name === 'edit_plan') {
        planEditTasks.push({ tcId, args: args as unknown as { goal?: string; items: { text: string; status: string; evidence?: unknown }[] } });
        continue;
      }

      if (tc.function.name === 'read_plan') {
        planReadTasks.push({ tcId, args: args as unknown as PlanReadArgs });
        continue;
      }

      if (tc.function.name === 'recall_source') {
        recallTasks.push({ tcId, args: args as unknown as RecallSourceArgs });
        continue;
      }

      if (tc.function.name === READ_BUDGET_TOOL_NAME) {
        budgetReadTasks.push({ tcId });
        continue;
      }

      if (tc.function.name === DECLINE_REQUEST_TOOL_NAME) {
        /* Reason is required by the schema; a missing one still ends the run,
           because leaving the call unanswered breaks the provider turn. */
        const rawReason = (args as Record<string, unknown>).reason;
        const reason = typeof rawReason === 'string' && rawReason.trim()
          ? rawReason.trim()
          : 'No reason given.';
        declineTasks.push({ tcId, reason });
        continue;
      }

      if (tc.function.name === 'fetch_url') {
        /* A list, like `web_search`. A single call can carry several pages, so the
           step and the fetch task are per URL: dedup, credits, `[Source #N]` and
           the tool result all have to address a page, not a call. */
        const raw = args.urls ?? args.url;
        const list = Array.isArray(raw) ? raw : [raw];
        let accepted = 0;
        for (const entry of list) {
          const url = String(entry ?? '').trim();
          if (!url) continue;
          if (accepted >= MAX_URLS_PER_FETCH_CALL) break;
          accepted++;
          const s: AgentStep = { type: 'webpage', query: url, model: currentModel };
          const stepIndex = steps.length;
          steps.push(s); onEvent({ type: 'step', data: s });
          /* One call id serves every URL in it, so the result is keyed per URL:
             a later entry must not overwrite an earlier one's text. The tool
             message still goes to the call id alone. Both sides of the map must
             derive the key the same way: reading the map back with the bare call
             id returns undefined for every URL but the first, and the failure
             only shows up when a page actually fails to extract. */
          fetchTasks.push({ tcId, url, stepIndex, key: fetchResultsKey(tcId, accepted) });
        }
        if (accepted === 0) {
          messages.push({ role: 'tool', tool_call_id: tcId, content: 'No readable URL in the fetch_url call.' });
        }
        continue;
      }

      const qs = args.queries || args.search_query || args.query || args.searchquery || args.q;
      const searchType = String(args.type || 'search');
      if (Array.isArray(qs)) {
        for (const q of qs) {
          if (typeof q === 'string' && q.trim()) {
            const s: AgentStep = { type: searchType === 'search' ? 'search' : searchType, query: q.trim(), model: currentModel };
            const stepIndex = steps.length;
            steps.push(s); onEvent({ type: 'step', data: s });
            searchTasks.push({ tcId, query: q.trim(), type: searchType, stepIndex });
          }
        }
      } else if (typeof qs === 'string' && qs.trim()) {
        const s: AgentStep = { type: searchType === 'search' ? 'search' : searchType, query: qs.trim(), model: currentModel };
        const stepIndex = steps.length;
        steps.push(s); onEvent({ type: 'step', data: s });
        searchTasks.push({ tcId, query: qs.trim(), type: searchType, stepIndex });
      }
    }

    const totalTasks = searchTasks.length + fetchTasks.length;
    /* A round whose only call was report_progress did no research, so it is not
       an error and does not advance the wrap-up counters. Progress calls are
       already answered by the time this is reached. */
    if (totalTasks === 0 && recallTasks.length === 0 && planCreateTasks.length === 0 && planEditTasks.length === 0 && planReadTasks.length === 0 && budgetReadTasks.length === 0 && declineTasks.length === 0) {
      if (publishedProgressCalls > 0) return { kind: 'tools', researchToolCalls: 0 };
      console.log('[tool_calls] no valid tasks found');
      for (const tc of msg.tool_calls) {
        const tcId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        messages.push({ role: 'tool', tool_call_id: tcId, content: 'Invalid tool call arguments. No results available.' });
      }
      return { kind: 'tools', researchToolCalls: 0 };
    }
    /* Plan tasks. Reconnaissance first: a plan written before any search or
       fetch has returned is a guess, so the engine refuses it and the search
       in the same batch still runs. */
    if (planCreateTasks.length > 0 && researchPlanRef) {
      /* Reconnaissance first: a plan written before any search or fetch has
         returned is a guess. The searches in the same batch still run. */
      if (budget.usedSearchCalls + budget.usedFetchCalls === 0) {
        for (const task of planCreateTasks) {
          messages.push({
            role: 'tool',
            tool_call_id: task.tcId,
            content: 'Plan rejected: run at least one search or fetch first, then create the plan from what the results showed.',
          });
        }
        if (traceId) traceEvent(traceId, 'tool.skipped', { tool: 'create_plan', reason: 'reconnaissance first' }, round);
      } else {
        for (const task of planCreateTasks) {
          const items = (task.args.items ?? []).map(i => ({ text: i.text, status: 'pending' as const }));
          researchPlanRef.current = { goal: task.args.goal || '', items };
          const s: AgentStep = { type: 'plan', note: `**${task.args.goal}**\n\n${items.map(i => `- [ ] ${i.text}`).join('\n')}` };
          steps.push(s); onEvent({ type: 'step', data: s });
          messages.push({
            role: 'tool',
            tool_call_id: task.tcId,
            content: JSON.stringify({ ok: true, summary: planSummary(researchPlanRef.current), note: 'Plan stored. It is not in your context; call read_plan to see it again.' }),
          });
        }
        if (traceId) {
          traceEvent(traceId, 'plan.create', { goal: researchPlanRef.current?.goal, summary: planSummary(researchPlanRef.current) }, round);
        }
      }
    }
    if (deepState && planReadTasks.length > 0) {
      for (const task of planReadTasks) {
        const view = planForModel(researchPlanRef?.current ?? null, task.args);
        messages.push({ role: 'tool', tool_call_id: task.tcId, content: view.content });
        if (traceId) {
          traceEvent(traceId, 'plan.read', { args: task.args, returned_chars: view.content.length, truncated: view.truncated, next_offset: view.nextOffset }, round);
          traceLive(traceId, `ROUND ${round} TOOL RESULT read_plan`, view.content);
        }
      }
    }
    if (planEditTasks.length > 0 && researchPlanRef?.current) {
      const knownSources = new Set(Array.from(allSources.values()).map((s) => s.source_index));
      for (const task of planEditTasks) {
        /* A done item must point at sources the job has seen. Rejected edits
           leave the stored plan untouched, so gaming the checklist costs a
           retry instead of closing the work. */
        const problems = validatePlanEditItems(task.args.items ?? [], knownSources);
        if (problems.length > 0) {
          messages.push({
            role: 'tool',
            tool_call_id: task.tcId,
            content: `Plan edit rejected:\n- ${problems.join('\n- ')}`,
          });
          if (traceId) traceEvent(traceId, 'tool.skipped', { tool: 'edit_plan', reason: 'done without evidence', problems }, round);
          continue;
        }
        const plan = researchPlanRef.current;
        if (task.args.goal) plan.goal = task.args.goal;
        plan.items = (task.args.items ?? []).map(i => ({
          text: i.text,
          status: (['pending', 'done', 'failed'].includes(i.status) ? i.status : 'pending') as 'pending' | 'done' | 'failed',
          evidence: Array.isArray(i.evidence) ? i.evidence.filter((n): n is number => typeof n === 'number') : undefined,
        }));
        const s: AgentStep = { type: 'plan', note: `${plan.goal}\n\n${plan.items.map(i => {
          const icon = i.status === 'done' ? '[x]' : i.status === 'failed' ? '[-]' : '[ ]';
          return `- ${icon} ${i.text}`;
        }).join('\n')}` };
        steps.push(s); onEvent({ type: 'step', data: s });
        messages.push({
          role: 'tool',
          tool_call_id: task.tcId,
          content: JSON.stringify({ ok: true, summary: planSummary(plan), note: 'Plan updated. It is not in your context; call read_plan to see it again.' }),
        });
      }
      if (traceId) {
        traceEvent(traceId, 'plan.edit', { goal: researchPlanRef.current?.goal, summary: planSummary(researchPlanRef.current) }, round);
      }
    }

    if (totalTasks === 0 && recallTasks.length === 0 && planCreateTasks.length === 0 && planEditTasks.length === 0 && planReadTasks.length === 0 && budgetReadTasks.length === 0 && declineTasks.length === 0) {
      return { kind: 'tools', researchToolCalls: 0 };
    }
    /* Decline wins terminally and spends nothing further: research tasks in
       the same batch are dropped unexecuted, and every other call id still
       gets a result so the provider accepts the turn. */
    if (declineTasks.length > 0) {
      const reason = declineTasks[0].reason;
      for (const task of declineTasks) {
        messages.push({ role: 'tool', tool_call_id: task.tcId, content: `Request declined: ${reason}` });
        answeredTcIds.add(task.tcId);
      }
      for (const tc of msg.tool_calls) {
        const otherId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        if (answeredTcIds.has(otherId)) continue;
        answeredTcIds.add(otherId);
        messages.push({ role: 'tool', tool_call_id: otherId, content: 'Request declined; no results.' });
      }
      if (traceId) traceEvent(traceId, 'note', { declined: reason }, round);
      return { kind: 'declined', reason };
    }
    /* Post-turn reading: answered after the turn's searches and fetches are
       charged, so a batch carrying `read_budget` reports the remainder the
       next batch is sized from, not the balance before it. */
    const answerBudgetReads = (): void => {
      for (const task of budgetReadTasks) {
        const reading = budgetReadingForModel(budget, preset);
        messages.push({ role: 'tool', tool_call_id: task.tcId, content: reading });
        if (traceId) {
          traceEvent(traceId, 'tool.result', { tool: READ_BUDGET_TOOL_NAME, call_id: task.tcId, returned_chars: reading.length }, round);
        }
      }
    };
    const searchBudgetLeft = remainingSearchCalls(budget, preset);
    const fetchBudgetLeft = remainingFetchCalls(budget, preset);
    if (searchBudgetLeft <= 0 && fetchBudgetLeft <= 0) {
      onRoundProgress?.();
      for (const tc of msg.tool_calls.filter(tc => !LOCAL_TOOL_NAMES.has(tc.function.name))) {
        const tcId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        messages.push({ role: 'tool', tool_call_id: tcId, content: 'Search and page-read ceilings reached for this job. Answer from the evidence already gathered.' });
      }
      answerBudgetReads();
      return { kind: 'tools', researchToolCalls: 0 };
    }

    if (deepState && traceId && recallTasks.length > 0) {
      for (const task of recallTasks) {
        const view = recallSource(traceId, task.args);
        messages.push({
          role: 'tool',
          tool_call_id: task.tcId,
          content: view.content,
        });
        /* A recall proves the model needed something it could not see. That is
           a forgetting signal with no threshold: clear old rounds next round
           start so the working set stays relevant. The recalled text itself is
           a fresh message and is never cleared by the pass it triggers. */
        deepState.recallPendingClear = true;
        traceEvent(traceId, 'tool.result', {
          tool: 'recall_source',
          call_id: task.tcId,
          source: task.args.source,
          returned_chars: view.content.length,
          truncated: view.truncated,
          next_offset: view.nextOffset,
        }, round);
        traceLive(traceId, `ROUND ${round} TOOL RESULT recall_source(${String(task.args.source)})`, view.content);
      }
    } else if (recallTasks.length > 0) {
      for (const task of recallTasks) {
        messages.push({ role: 'tool', tool_call_id: task.tcId, content: 'recall_source is only available on a stored research job.' });
      }
    }

    const duplicateToolNotes = new Map<string, string[]>();
    const freshSearchTasks: typeof searchTasks = [];
    for (const s of searchTasks) {
      if (deepState) {
        const prior = findPriorSearch(deepState.ledger, s.query);
        if (prior) {
          const notes = duplicateToolNotes.get(s.tcId) ?? [];
          notes.push(duplicateSearchToolMessage(prior));
          duplicateToolNotes.set(s.tcId, notes);
          const dupStep: AgentStep = { type: 'search', query: s.query, note: 'Skipped duplicate query — see research ledger', model: currentModel, duration_ms: 0, result_count: 0 };
          steps.push(dupStep);
          onEvent({ type: 'step', data: dupStep });
          continue;
        }
      }
      freshSearchTasks.push(s);
    }

    const freshFetchTasks: typeof fetchTasks = [];
    for (const f of fetchTasks) {
      if (deepState) {
        const prior = findPriorFetch(deepState.ledger, f.url);
        if (prior?.ok) {
          const notes = duplicateToolNotes.get(f.tcId) ?? [];
          notes.push(duplicateFetchToolMessage(prior));
          duplicateToolNotes.set(f.tcId, notes);
          const dupStep: AgentStep = { type: 'webpage', query: f.url, note: 'Skipped duplicate fetch — see research ledger', model: currentModel, duration_ms: 0, result_count: 0 };
          steps.push(dupStep);
          onEvent({ type: 'step', data: dupStep });
          continue;
        }
      }
      freshFetchTasks.push(f);
    }

    const allowedSearchTasks = freshSearchTasks.slice(0, searchBudgetLeft);
    const allowedFetchTasks = freshFetchTasks.slice(0, fetchBudgetLeft);
    const allowedCount = allowedSearchTasks.length + allowedFetchTasks.length;

    if (allowedCount === 0 && duplicateToolNotes.size > 0) {
      for (const [tcId, notes] of duplicateToolNotes) {
        messages.push({
          role: 'tool',
          tool_call_id: tcId,
          content: `${notes.join('\n\n')}\n\n[No credits spent — use the ledger evidence and pick a new next_action.]`,
        });
      }
      onRoundProgress?.();
      answerBudgetReads();
      return { kind: 'tools', researchToolCalls: 0 };
    }

    if (allowedCount < totalTasks) {
      const s: AgentStep = { type: 'budget', note: `Research pacing limited this round to ${allowedCount} of ${totalTasks} requested tasks.` };
      steps.push(s); onEvent({ type: 'step', data: s });
    }

    const searchTimestamps = allowedSearchTasks.map(() => performance.now());
    const fetchTimestamps = allowedFetchTasks.map(() => performance.now());
    interface IndexedResult { id: number | null; url: string; title: string; snippet: string | null; source_index: number; date: string | null; }
    const resultsByTcId = new Map<string, IndexedResult[]>();

    for (const s of allowedSearchTasks) {
      if (!resultsByTcId.has(s.tcId)) resultsByTcId.set(s.tcId, []);
    }
    for (const f of allowedFetchTasks) {
      if (!resultsByTcId.has(f.key)) resultsByTcId.set(f.key, []);
    }

    const searchPromises = allowedSearchTasks.map((s, i) =>
      withRetry('web_search', retryDelays, () => searchResults(s.query, s.type, signal), {
        signal,
        onRetry: (info) => {
          if (traceId) {
            traceEvent(traceId, 'tool.skipped', {
              tool: 'web_search', query: s.query, attempt: info.attempt,
              delay_ms: info.delayMs, error: info.error,
            }, round);
          }
        },
      }).then((outcome) => {
        const step = steps[s.stepIndex];
        step.duration_ms = Math.round(performance.now() - searchTimestamps[i]);
        /* The real reason is surfaced to the model and the trace. A run that
           keeps failing says why, instead of returning a short answer. */
        if (!outcome.ok) {
          step.note = `Search failed after ${outcome.attempts} attempt(s): ${outcome.error}`;
          onEvent({ type: 'step', data: step });
          if (resultsByTcId.has(s.tcId)) {
            resultsByTcId.get(s.tcId)!.push({
              id: 0, title: 'Search failed', url: '', source_index: 0,
              snippet: `Search failed after ${outcome.attempts} attempt(s): ${outcome.error}`, date: null,
            });
          }
          return;
        }
        const results = outcome.value?.results ?? [];
        step.result_count = results.length;
        onEvent({ type: 'step', data: step });
        const topUrls = results.map(r => r.url);
        if (deepState) recordLedgerSearch(deepState.ledger, s.query, round, results.length, topUrls);
        for (const r of results) {
          if (!allSources.has(r.url)) {
            allSources.set(r.url, { title: r.title, url: r.url, domain: domain(r.url), snippet: r.snippet, source_index: allSources.size + 1 });
          }
          /* The store is written at arrival, not at clearing time, so a source
             is recoverable even if the job dies before any offload pass. */
          if (traceId) {
            storeEvidence(traceId, {
              sourceIndex: allSources.get(r.url)?.source_index ?? 0,
              url: r.url,
              title: r.title,
              kind: 'search_result',
              fetched: false,
              text: r.snippet || '',
              round,
            });
          }
        }
        if (!resultsByTcId.has(s.tcId)) resultsByTcId.set(s.tcId, []);
        resultsByTcId.get(s.tcId)!.push(...results.map(r => ({ ...r, source_index: allSources.get(r.url)?.source_index ?? 0 })));
        onEvent({ type: 'sources', sources: Array.from(allSources.values()).map(toPublicSource) });
      })
    );

    const fetchPromises = allowedFetchTasks.map((f, i) =>
      withRetry('fetch_url', retryDelays, () => extractPageContent(f.url, signal), {
        signal,
        onRetry: (info) => {
          if (traceId) {
            traceEvent(traceId, 'tool.skipped', {
              tool: 'fetch_url', url: f.url, attempt: info.attempt,
              delay_ms: info.delayMs, error: info.error,
            }, round);
          }
        },
      }).then((outcome) => {
        const step = steps[f.stepIndex];
        step.duration_ms = Math.round(performance.now() - fetchTimestamps[i]);
        if (!outcome.ok) {
          step.note = `Could not read page after ${outcome.attempts} attempt(s): ${outcome.error}`;
          onEvent({ type: 'step', data: step });
          if (deepState) recordLedgerFetch(deepState.ledger, f.url, round, false, f.url);
          if (!resultsByTcId.has(f.key)) resultsByTcId.set(f.key, []);
          resultsByTcId.get(f.key)!.push({
            id: 0, title: f.url, url: f.url, source_index: 0,
            snippet: `This page could not be fetched after ${outcome.attempts} attempt(s): ${outcome.error}`, date: null,
          });
          return;
        }
        const { title, content, error } = outcome.value!;
        if (error) {
          step.note = `Could not read page (${error})`; onEvent({ type: 'step', data: step });
          if (deepState) recordLedgerFetch(deepState.ledger, f.url, round, false, f.url);
          if (!resultsByTcId.has(f.key)) resultsByTcId.set(f.key, []);
          resultsByTcId.get(f.key)!.push({ id: 0, title: f.url, url: f.url, source_index: 0, snippet: `This page could not be fetched: ${error}`, date: null });
          return;
        }
        step.note = title || ''; onEvent({ type: 'step', data: step });
        if (deepState) recordLedgerFetch(deepState.ledger, f.url, round, true, title || f.url);
        if (!allSources.has(f.url)) {
          allSources.set(f.url, { title: title || f.url, url: f.url, domain: domain(f.url), snippet: content.slice(0, getConfig().search.extractionSnippetChars), source_index: allSources.size + 1 });
        }
        if (traceId) {
          storeEvidence(traceId, {
            sourceIndex: allSources.get(f.url)?.source_index ?? 0,
            url: f.url,
            title: title || f.url,
            kind: 'page',
            fetched: true,
            text: content,
            round,
          });
        }
        const idx = allSources.get(f.url)?.source_index ?? 0;
        if (!resultsByTcId.has(f.key)) resultsByTcId.set(f.key, []);
        resultsByTcId.get(f.key)!.push({ id: idx, title: title || f.url, url: f.url, source_index: idx, snippet: content.slice(0, getConfig().search.extractionContextChars), date: null });
        onEvent({ type: 'sources', sources: Array.from(allSources.values()).map(toPublicSource) });
      }).catch((err: unknown) => {
        const step = steps[f.stepIndex];
        step.duration_ms = Math.round(performance.now() - fetchTimestamps[i]);
        const message = (err as Error).message || 'Page extraction failed';
        step.note = `Could not read page (${message})`; onEvent({ type: 'step', data: step });
        if (resultsByTcId.has(f.key)) {
          resultsByTcId.get(f.key)!.push({ id: 0, title: f.url, url: f.url, source_index: 0, snippet: `Page extraction failed: ${message}`, date: null });
        }
      })
    );

    const allCount = allowedSearchTasks.length + allowedFetchTasks.length;
    if (allCount > 0) {
      const batchStep: AgentStep = { type: deepState ? 'analyze' : 'search', note: `Running ${allCount} searches...` };
      steps.push(batchStep);
      onEvent({ type: 'step', data: batchStep });
    }

    if (allCount > 0) {
      /* Periodic heartbeat during search/fetch wait (prevents SSE timeout if one request hangs) */
      const intervalMs = getConfig().research.toolWaitHeartbeatMs;
      const waitPromise = Promise.all([...searchPromises, ...fetchPromises]);
      const heartbeatInt = setInterval(() => {
        const s: AgentStep = { type: deepState ? 'analyze' : 'search', note: 'Waiting for search results...' };
        onEvent({ type: 'step', data: s });
      }, intervalMs);
      try {
        await waitPromise;
      } finally {
        clearInterval(heartbeatInt);
      }
    } else {
      await Promise.all([...searchPromises, ...fetchPromises]);
    }

    for (const [key, indexedResults] of resultsByTcId.entries()) {
      const seenUrls = new Set<string>();
      const dedupedResults = indexedResults.filter((r) => { if (seenUrls.has(r.url)) return false; seenUrls.add(r.url); return true; });
      const textList = dedupedResults.map((r, index: number) =>
        formatResultLine(r, index + 1)
      ).join('\n\n');
      /* Fetch results are keyed `callId#n` because one call can carry several
         pages and they share a single tool message. The message still goes to the
         call id, or the provider rejects the turn. */
      const callId = key.split('#')[0];
      const duplicatePrefix = duplicateToolNotes.get(callId)?.join('\n\n');
      const body = [duplicatePrefix, textList].filter(Boolean).join('\n\n');
      messages.push({ role: 'tool', tool_call_id: callId, content: body });
      if (traceId) {
        traceEvent(traceId, 'tool.result', {
          tool: callId === key ? 'web_search' : 'fetch_url',
          call_id: callId,
          result_key: key,
          results: dedupedResults.length,
          skipped_duplicate: Boolean(duplicatePrefix),
          result_chars: body.length,
        }, round);
        traceLive(traceId, `ROUND ${round} TOOL RESULT web_search`, body);
      }
    }

    for (const [tcId, notes] of duplicateToolNotes) {
      if (resultsByTcId.has(tcId)) continue;
      messages.push({
        role: 'tool',
        tool_call_id: tcId,
        content: `${notes.join('\n\n')}\n\n[No credits spent — use the ledger evidence and pick a new next_action.]`,
      });
    }

    /* A call to a retired tool (remembered from an earlier round) must still
       get a result for its call id, or the provider rejects the next turn.
       Only for actually-spent allowances; partial rounds keep their pacing
       note instead. */
    const servedTcIds = new Set(Array.from(resultsByTcId.keys()).map((key) => key.split('#')[0]));
    if (remainingSearchCalls(budget, preset) <= 0) {
      for (const s of searchTasks) {
        if (!servedTcIds.has(s.tcId) && !duplicateToolNotes.has(s.tcId)) {
          servedTcIds.add(s.tcId);
          messages.push({ role: 'tool', tool_call_id: s.tcId, content: 'Search allowance for this job is spent. Continue reading what you found with fetch_url.' });
        }
      }
    }
    if (remainingFetchCalls(budget, preset) <= 0) {
      for (const f of fetchTasks) {
        if (!servedTcIds.has(f.tcId) && !duplicateToolNotes.has(f.tcId)) {
          servedTcIds.add(f.tcId);
          messages.push({ role: 'tool', tool_call_id: f.tcId, content: 'Page-read allowance for this job is spent. Answer from the evidence already gathered.' });
        }
      }
    }

    chargeSearchCalls(budget, allowedSearchTasks.length);
    chargeFetchCalls(budget, allowedFetchTasks.length);
    answerBudgetReads();
    onRoundProgress?.();
    const researchToolCalls = new Set([
      ...allowedSearchTasks.map(task => task.tcId),
      ...allowedFetchTasks.map(task => task.tcId),
    ]).size;
    return { kind: 'tools', researchToolCalls };
  }

  /* Inline tool call: only for models declared in settings as writing the call
     into the text body. Any other model's content is treated as an answer, so a
     stray JSON blob is never mistaken for a tool invocation. */
  const content = msg.content || '';
  const inlineCall = inlineAllowed ? parseInlineToolCall(content) : null;
  if (inlineCall) {
    const allQueries = inlineCall.queries?.length ? inlineCall.queries : [(inlineCall.query || '').trim()].filter(Boolean);
    if (allQueries.length > 0) {
      console.log(`[inline tool] parsed ${allQueries.length} query(s):`, allQueries);
      messages.push({ role: msg.role, content: content.replace(inlineCall.raw, '').trim() || null, reasoning: reasoningText ?? null });

      const inlineDuplicateNotes: string[] = [];
      const freshInlineQueries: string[] = [];
      for (const q of allQueries) {
        if (deepState) {
          const prior = findPriorSearch(deepState.ledger, q);
          if (prior) {
            inlineDuplicateNotes.push(duplicateSearchToolMessage(prior));
            const dupStep: AgentStep = { type: 'search', query: q, note: 'Skipped duplicate query — see research ledger', model: currentModel, duration_ms: 0, result_count: 0 };
            steps.push(dupStep);
            onEvent({ type: 'step', data: dupStep });
            continue;
          }
        }
        freshInlineQueries.push(q);
      }
      const allowedQueries = freshInlineQueries.slice(0, remainingSearchCalls(budget, preset));
      const tcId = `call_inline_${Date.now()}`;
      if (allowedQueries.length === 0 && inlineDuplicateNotes.length > 0) {
        messages.push({
          role: 'tool',
          tool_call_id: tcId,
          content: `${inlineDuplicateNotes.join('\n\n')}\n\n[No credits spent — use the ledger evidence.]`,
        });
        onRoundProgress?.();
        return { kind: 'tools', researchToolCalls: 0 };
      }
      const queryTimestamps = allowedQueries.map(() => performance.now());
      const queryStepIndices: number[] = [];

      for (const q of allowedQueries) {
        const qStep: AgentStep = { type: 'search', query: q, model: currentModel };
        queryStepIndices.push(steps.length);
        steps.push(qStep); onEvent({ type: 'step', data: qStep });
      }

      let allResults: SearchResult[] = [];
      if (allowedQueries.length > 0) {
        const intervalMs = getConfig().research.toolWaitHeartbeatMs;
        const queryPromise = Promise.all(allowedQueries.map(async (q, i) => {
          const outcome = await withRetry('web_search', retryDelays, () => searchResults(q, 'search', signal), {
            signal,
            onRetry: (info) => {
              if (traceId) {
                traceEvent(traceId, 'tool.skipped', {
                  tool: 'web_search', query: q, attempt: info.attempt,
                  delay_ms: info.delayMs, error: info.error,
                }, round);
              }
            },
          });
          const qStep = steps[queryStepIndices[i]];
          qStep.duration_ms = Math.round(performance.now() - queryTimestamps[i]);
          if (!outcome.ok) {
            qStep.note = `Search failed after ${outcome.attempts} attempt(s): ${outcome.error}`;
            onEvent({ type: 'step', data: qStep });
            return [];
          }
          const results = outcome.value?.results ?? [];
          qStep.result_count = results.length;
          onEvent({ type: 'step', data: qStep });
          if (deepState) recordLedgerSearch(deepState.ledger, q, round, results.length, results.map(r => r.url));
          return results;
        }));
        const hbInt = setInterval(() => {
          const s: AgentStep = { type: deepState ? 'analyze' : 'search', note: 'Waiting for search results...' };
          onEvent({ type: 'step', data: s });
        }, intervalMs);
        try {
          allResults = (await queryPromise).flat();
        } finally {
          clearInterval(hbInt);
        }
      }

      for (const r of allResults) {
        if (!allSources.has(r.url)) {
          allSources.set(r.url, { title: r.title, url: r.url, domain: domain(r.url), snippet: r.snippet, source_index: allSources.size + 1 });
        }
      }

      const seenUrls = new Set<string>();
      const dedupedResults = allResults.filter(r => { if (seenUrls.has(r.url)) return false; seenUrls.add(r.url); return true; });
      const textList = dedupedResults.map((r, index) =>
        formatResultLine({ source_index: allSources.get(r.url)?.source_index ?? 0, title: r.title, url: r.url, snippet: r.snippet }, index + 1)
      ).join('\n\n');
      const inlineBody = [inlineDuplicateNotes.join('\n\n'), textList].filter(Boolean).join('\n\n');
      messages.push({ role: 'tool', tool_call_id: tcId, content: inlineBody });
      if (traceId) {
        traceEvent(traceId, 'tool.result', {
          tool: 'web_search',
          call_id: tcId,
          queries: allowedQueries.length,
          results: dedupedResults.length,
          skipped_duplicate: allowedQueries.length === 0,
          result_chars: inlineBody.length,
        }, round);
        traceLive(traceId, `ROUND ${round} TOOL RESULT web_search`, inlineBody);
      }

      chargeSearchCalls(budget, allowedQueries.length);
      onRoundProgress?.();
      onEvent({ type: 'sources', sources: Array.from(allSources.values()).map(toPublicSource) });
      return { kind: 'tools', researchToolCalls: allowedQueries.length > 0 ? 1 : 0 };
    }
  }

  /* Model answered — no tool calls, direct response */
  const finalStep: AgentStep = { type: 'answer' };
  steps.push(finalStep);
  onEvent({ type: 'step', data: finalStep });
  messages.push({ role: msg.role, content: msg.content, reasoning: reasoningText ?? null });
  return { kind: 'answer' };
}


/* ── Agentic research loop ── */

/**
 * Public entry point and engine selector. `sandbox.enabled` runs the code
 * engine ([CODE-EXECUTION-PLAN.md](../../docs/CODE-EXECUTION-PLAN.md)); the
 * classic loop runs otherwise. They are two engines on a shared spine, not one
 * loop with a switch: the classic path's tools, prompt, ledger and wrap-up
 * counters are code-free, and the code path's prompt never names a classic
 * tool. The wrapper exists for one reason: a job's sandbox has to die on every
 * exit path — answered, errored, cancelled, or thrown — and a single `finally`
 * is the only place that cannot be forgotten.
 */
export async function agenticResearchStream(
  query: string,
  history: { role: string; content: string }[] | undefined,
  onEvent: (event: EngineEvent) => void,
  mode: ResearchMode = DEFAULT_RESEARCH_MODE,
  options: ResearchRunOptions = {},
): Promise<void> {
  try {
    if (getConfig().sandbox.enabled) {
      await runCodeResearchStream(query, history, onEvent, mode, options);
    } else {
      await runAgenticResearchStream(query, history, onEvent, mode, options);
    }
  } finally {
    if (options.jobId) closeSandbox(options.jobId);
  }
}

async function runAgenticResearchStream(
  query: string,
  history: { role: string; content: string }[] | undefined,
  onEvent: (event: EngineEvent) => void,
  mode: ResearchMode = DEFAULT_RESEARCH_MODE,
  options: ResearchRunOptions = {},
): Promise<void> {
  const preset = options.preset ?? resolveResearchPreset(mode);
  /* Effort follows the mode. A legacy chat caller with no mode still gets the
     default mode's level rather than being left without one. */
  const reasoningEffort = reasoningEffortForMode(preset.mode);
  const start = performance.now();
  /* The job id doubles as the trace id, so a run and its trace share a name and
     the trace is findable the moment the job id is known. */
  const traceId = options.jobId;
  if (traceId) {
    traceEvent(traceId, 'run.start', {
      query,
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
  const deepState: DeepResearchState = { ledger: createResearchLedger(), preset };
  const budget: BudgetState = createBudgetState();

  let startRound = 0;
  if (options.jobId) {
    const checkpoint = loadResearchCheckpoint(options.jobId);
    if (checkpoint && checkpoint.preset.mode === preset.mode) {
      Object.assign(budget, checkpoint.budget);
      /* Rows written before these counters existed resume at zero rather than
         NaN: undefined plus a number is not a number. */
      budget.usedTotalTokens ??= 0;
      budget.usedCpuMs ??= 0;
      budget.startedAt = Date.now() - (Date.now() - budget.startedAt);
      startRound = checkpoint.round;
      for (const source of checkpoint.sourceMap) {
        allSources.set(source.url, source);
      }
      const resumeStep: AgentStep = {
        type: 'checkpoint',
        note: `Resumed from checkpoint at round ${startRound} (${remainingSearchCalls(budget, preset)} search and ${remainingFetchCalls(budget, preset)} page reads remaining).`,
      };
      steps.push(resumeStep);
      onEvent({ type: 'step', data: resumeStep });
      if (traceId) {
        traceEvent(traceId, 'note', { resumed: true, start_round: startRound }, startRound);
      }
    }
  }
  const now = new Date();
  const today = `${now.toLocaleDateString('en-US', { month: 'long' })} ${now.getDate()}, ${now.getFullYear()}`;
  const researchPlanRef: { current: ResearchPlan | null } = { current: null };
  const resumeBlock = startRound > 0
    ? `\n\n**Resume:** This job resumed from round ${startRound}. Use the cited sources; do not repeat completed research unless a gap reopened.`
    : '';
  const basePrompt = options.researchApi
    ? getApiResearchSystemPrompt(options.planningEnabled !== false)
    : getDeepSystemPrompt(options.planningEnabled !== false);
  /* The prompt defines what each length means; this line only names the one
     this run was asked for. */
  const lengthBlock = responseLengthBlock(options.responseLength ?? DEFAULT_RESPONSE_LENGTH);
  const planningEnabled = options.planningEnabled !== false;
  const systemPrompt = `${basePrompt}\n\n**Today's date:** ${today}.`
    + lengthBlock + resumeBlock + modeBehaviorBlock(preset, 'fetch_url', planningEnabled);
  /* The assembled system prompt is the largest single determinant of what a run
     does, and it is stitched from pieces that live in different files and
     vary with the mode, the response length and the date. A
     trace carrying only the query could not say which of those produced a given
     behaviour, so the whole thing is recorded once, here. */
  if (traceId) traceEvent(traceId, 'prompt.assembled', { system_prompt: systemPrompt, response_length: options.responseLength ?? DEFAULT_RESPONSE_LENGTH }, 0);
  const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];
  const sanitizedHistory = sanitizeHistory(history, query);
  if (sanitizedHistory.length > 0) messages.push(...sanitizedHistory.map(h => ({ role: h.role, content: h.content })));
  messages.push({ role: 'user', content: query });
  /* The routing role is the mode. This was the constant 'deep', so an `instant`
     job looked up the `deep` route and the `instant` route was read by nothing.
     `LLMRole` is derived from the ModelRouting keys, which are the modes, so a
     route configured for a mode is now the route that mode actually uses. */
  const activeRole: LLMRole = preset.mode;
  const sessionStartIdx = messages.length;

  const publishProgress = (roundNum: number) => {
    options.onProgress?.({
      budget: budgetSnapshot(budget, preset),
      budgetState: { ...budget },
      round: roundNum,
      mode: preset.mode,
      sourceMap: Array.from(allSources.values()),
    });
  };

  let hadError = false;
  let round = startRound;
  let totalTurns = 0;
  let totalToolCalls = 0;
  let wrapUpWarned = false;
  let retiredSearchNotified = false;
  let retiredFetchNotified = false;
  const maxTotalTurns = getConfig().research.maxTotalTurns;
  /* Thresholds follow the mode, with the research block as fallback. A single
     global pair would stop a max run at default depth, or let an instant run
     wander. */
  const FORCE_ANSWER_THRESHOLD = preset.forceAnswerToolCalls ?? getConfig().research.forceAnswerToolCalls;

  /* A reached ceiling is always reported, and the job still gets its answer. */
  const onRoundLimit = (ceiling: StopReason): void => {
    const snapshot = budgetSnapshot(budget, preset);
    const step: AgentStep = {
      type: 'budget',
      note: `Research stopped: ${ceiling} ceiling reached (${snapshot.used_search_calls}/${snapshot.search_calls_limit} searches, ${snapshot.used_fetch_calls}/${snapshot.fetch_calls_limit} page reads, ${snapshot.elapsed_ms}ms).`,
    };
    steps.push(step);
    onEvent({ type: 'step', data: step });
    options.onProgress?.({ budget: snapshot, budgetState: { ...budget }, round, mode: preset.mode });
    messages.push({
      role: 'user',
      content: `Your research budget is exhausted (${ceiling} limit reached). Write the final answer now using the evidence already gathered, and state explicitly what could not be confirmed.`,
    });
  };

  while (!hadError && totalTurns < maxTotalTurns) {
    if (options.signal?.aborted) break;
    budget.usedTurns = totalTurns;

    /* Code-enforced ceilings are evaluated before the model is allowed to act.
       Hard ceilings (wall clock, steps, tokens) remove the tools and force a
       final answer instead of silently rejecting calls. A spent search or fetch
       allowance retires only its own tool; the run continues on the other
       allowance while steps, tokens, and time remain. */
    const ceiling = checkCeilings(budget, preset);
    if (ceiling && !budget.exhaustedBy) {
      const hardCeiling = ceiling === 'wall_clock' || ceiling === 'steps' || ceiling === 'tokens';
      const bothOut = remainingSearchCalls(budget, preset) <= 0 && remainingFetchCalls(budget, preset) <= 0;
      if (hardCeiling || bothOut) {
        budget.exhaustedBy = ceiling;
        onRoundLimit(ceiling);
      } else if (ceiling === 'search_calls' && !retiredSearchNotified) {
        retiredSearchNotified = true;
        messages.push({ role: 'user', content: SEARCH_RETIRED_MESSAGE });
        if (traceId) traceEvent(traceId, 'note', { tool_retired: 'web_search' }, round);
      } else if (ceiling === 'fetch_calls' && !retiredFetchNotified) {
        retiredFetchNotified = true;
        messages.push({ role: 'user', content: FETCH_RETIRED_MESSAGE });
        if (traceId) traceEvent(traceId, 'note', { tool_retired: 'fetch_url' }, round);
      }
    }

    const forceAnswer = budget.exhaustedBy !== null || totalToolCalls >= FORCE_ANSWER_THRESHOLD;
    if (!forceAnswer && !wrapUpWarned && shouldWrapUp(budget, preset, totalToolCalls)) {
      /* The prompt's stopping rule names this signal, so keep the marker. */
      messages.push({ role: 'user', content: WRAP_UP_MESSAGE });
      wrapUpWarned = true;
    }

    const result = await toolCallingRound(messages, allSources, steps, round, onEvent, budget, preset, () => publishProgress(round), options.signal, activeRole, deepState, forceAnswer, options.planningEnabled !== false, researchPlanRef, reasoningEffort, options.researchApi, traceId, options.verbosity, totalTurns, options.responseLength ?? DEFAULT_RESPONSE_LENGTH);
    if (result.kind === 'error') { hadError = true; break; }
    if (result.kind === 'declined') {
      onEvent({ type: 'declined', reason: result.reason });
      if (traceId) {
        traceEvent(traceId, 'run.end', {
          outcome: 'declined',
          reason: result.reason,
          total_tool_calls: totalToolCalls,
          rounds: round + 1,
          tokens_used: budget.usedTokens,
          exhausted_by: budget.exhaustedBy,
        }, round);
      }
      return;
    }
    if (result.kind === 'answer') {
      /* Mechanical answer floor. The model keeps the semantic judgment; the
         engine owns this minimum, so an early answer is bounced with one
         floor-side message back instead of being taken. Bypassed once a
         ceiling forces the answer, so a spent run can always finish. */
      if (!forceAnswer) {
        const pending = researchPlanRef?.current?.items.filter((i) => i.status === 'pending').length ?? 0;
        const deficit = evidenceFloorDeficit(budget, preset, pending);
        if (deficit) {
          messages.push({ role: 'user', content: evidenceFloorMessage(preset, deficit) });
          if (traceId) {
            traceEvent(traceId, 'note', { evidence_floor: deficit, exhausted_by: budget.exhaustedBy }, round);
          }
          budget.usedSteps++;
          totalTurns++;
          publishProgress(round);
          continue;
        }
      }
      if (traceId) {
        /* The answer length is recorded because the empty-completion failure
           showed a short or blank final answer is the first thing to check. */
        traceEvent(traceId, 'note', {
          outcome: 'answer',
          answer_chars: messages[messages.length - 1]?.content?.length ?? 0,
          total_tool_calls: totalToolCalls,
          rounds: round + 1,
          tokens_used: budget.usedTokens,
          exhausted_by: budget.exhaustedBy,
        }, round);
      }
      break;
    }
    if (
      options.jobId && deepState && preset.checkpointEverySteps > 0
      && budget.usedSteps % preset.checkpointEverySteps === 0
    ) {
      saveResearchCheckpoint({
        jobId: options.jobId,
        query,
        preset,
          budget: { ...budget },
        reasoningEffort,
        verbosity: options.verbosity,
        researchApi: options.researchApi,
        round: round + 1,
        sourceMap: Array.from(allSources.values()),
        lastUpdatedAt: new Date().toISOString(),
      });
      const checkpointStep: AgentStep = {
        type: 'checkpoint',
        note: `Checkpoint saved at round ${round + 1}.`,
      };
      steps.push(checkpointStep);
      onEvent({ type: 'step', data: checkpointStep });
    }
    if (result.kind === 'tools') {
      if (result.researchToolCalls > 0) {
        round++;
        totalToolCalls += result.researchToolCalls;
      }
    }
    budget.usedSteps++;
    totalTurns++;
    publishProgress(round);
  }

  if (hadError || options.signal?.aborted) return;

  function finalContextJson(): string {
    return makeFinalContextJson(messages);
  }

  const finalSources: Source[] = Array.from(allSources.values()).map(toPublicSource);
  const sessionMessages = messages.slice(sessionStartIdx);
  /* The last non-empty assistant message is the answer. A model declared as
     writing tool calls inline has already had the call stripped from its
     content, so no filtering by content shape is needed or correct here. */
  const answerMsg = sessionMessages
    .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
    .pop();

  /* A run can end with no answer at all: the model returns an empty completion
     after a ceiling is reached. That is the failure this records, because it
     produces no `done` event and no step to inspect afterwards. */
  if (traceId) {
    traceEvent(traceId, 'run.end', {
      outcome: answerMsg?.content ? 'answered' : 'no_answer',
      answer_chars: answerMsg?.content?.length ?? 0,
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

  if (answerMsg?.content) {
    const elapsed = Math.round(performance.now() - start);
    const answer = sanitizeResearchAnswer(answerMsg.content, finalSources);
    if (options.jobId) deleteResearchCheckpoint(options.jobId);
    onEvent({ type: 'context', finalContext: finalContextJson() });

    const responseBase = {
      query,
      answer,
      sources: finalSources,
      steps,
      results_count: allSources.size,
      elapsed_ms: elapsed,
      research_budget: budgetSnapshot(budget, preset),
      mode: preset.mode,
      reasoning_effort: reasoningEffort,
      verbosity: options.verbosity,
    };

    /* The v1 API returns the structured evidence report; legacy chat callers keep the prose answer. */
    if (options.researchApi) {
      const reportStep: AgentStep = { type: 'report', note: 'Building the evidence report…' };
      steps.push(reportStep);
      onEvent({ type: 'step', data: reportStep });
      onEvent({ type: 'done', response: { ...responseBase, report: await buildReportForRun(query, answer, finalSources, options, preset, reasoningEffort, options.signal) } as SearchResponse });
      return;
    }

    onEvent({ type: 'done', response: responseBase as SearchResponse });
    return;
  }

  if (allSources.size > 0) {
    onEvent({ type: 'context', finalContext: finalContextJson() });
    onEvent({ type: 'error', message: budget.exhaustedBy !== null ? 'Research budget exhausted but the model produced no answer.' : 'Model used all rounds but produced no answer.' });
  } else {
    onEvent({ type: 'context', finalContext: finalContextJson() });
    onEvent({ type: 'error', message: 'Model could not produce an answer.' });
  }
}
