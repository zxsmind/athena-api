import { callLLM, stripThinkingTags, type LLMRole } from './llm.js';
import type { LLMResult } from './llm.js';
import { fetchResults, fetchPageContent } from './search.js';
import type { SearchResponse, Source, AgentStep } from './schemas.js';
import { SYSTEM_PROMPT, DEEP_SYSTEM_PROMPT } from './agent/prompts.js';
import { loadSettings } from './settings-store.js';
import { SEARCH_TOOL, FETCH_URL_TOOL, type EngineEvent, type ResearchBudgetState, type ResearchRunOptions, type SourceWithIndex } from './engine/types.js';
import { temperatureForRound, sanitizeHistory, domain } from './engine/history.js';
import { parseInlineToolCall } from './engine/tool-parser.js';
import {
  appendNotebookContent,
  createNotebook,
  loadNotebook,
  notebookContext,
  persistNotebook,
  readNotebookForModel,
  READ_NOTEBOOK_TOOL,
  WRITE_NOTEBOOK_TOOL,
  type NotebookReadArgs,
  type NotebookWriteArgs,
  type ResearchNotebook,
} from './engine/notebook.js';
import { deleteResearchCheckpoint, loadResearchCheckpoint, saveResearchCheckpoint } from './engine/checkpoint.js';
import { depthBehaviorBlock, resolveResearchPreset, type ResolvedResearchPreset } from './engine/depth-presets.js';
import {
  computeCooldownMs,
  createCooldownState,
  recordToolOutcomes,
  waitCooldown,
  type ResearchCooldownState,
  type ToolOutcome,
} from './engine/cooldown.js';
import { consumeRateSignalsForCooldown } from './engine/rate-signals.js';
import {
  compactedEvidenceNote,
  createResearchLedger,
  duplicateFetchToolMessage,
  duplicateSearchToolMessage,
  extractSourceUrlsFromToolContent,
  findPriorFetch,
  findPriorSearch,
  ledgerContextBlock,
  recordLedgerFetch,
  recordLedgerSearch,
  type ResearchLedger,
} from './engine/research-ledger.js';

export type { EngineEvent, ResearchRunOptions, ResearchBudgetState } from './engine/types.js';

interface LLMMessage {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

interface DeepResearchState {
  notebook: ResearchNotebook;
  ledger: ResearchLedger;
  lastCompactedMessageIndex: number;
  preset: ResolvedResearchPreset;
}

function makeFinalContextJson(messages: LLMMessage[]): string {
  const MAX_CTX_KB = 10;
  const MAX_CTX_MSGS = 20;
  const all = messages.map(m => ({ role: m.role, content: m.content })).filter((m): m is { role: string; content: string } => typeof m.content === 'string' && m.content.length > 0);
  const trimmed = all.length > MAX_CTX_MSGS ? all.slice(-MAX_CTX_MSGS) : all;
  let json = JSON.stringify(trimmed);
  if (json.length > MAX_CTX_KB * 1024) {
    json = json.slice(0, MAX_CTX_KB * 1024) + '\n...TRUNCATED';
  }
  return json;
}

function deepResearchContextBlock(deepState: DeepResearchState, cadenceInstruction: string): string {
  return [
    `Research ledger (completed searches/fetches — do not repeat these queries):\n${ledgerContextBlock(deepState.ledger)}`,
    `Deep research notebook (Markdown):\n${notebookContext(deepState.notebook)}`,
    'Use write_notebook to append Markdown notes after digesting raw results. Use read_notebook if the notebook is truncated and you need earlier sections. Do not repeat ledger queries.',
    'Write the final answer from the notebook, ledger, and source list. State what is verified, what is uncertain, and what could not be confirmed. Do not invent facts.',
    cadenceInstruction,
  ].filter(Boolean).join('\n\n');
}

function budgetExhaustedDeepMessage(): string {
  return 'Research budget exhausted. If raw evidence is not yet in the notebook, call write_notebook once with a Markdown summary. Then write the final answer using ONLY the notebook, research ledger, and source list. Cite with [N]. List remaining gaps explicitly; do not fill them with unsupported numbers or speculation.';
}

function roundsExhaustedDeepMessage(): string {
  return 'Research rounds limit reached. If raw evidence is not yet in the notebook, call write_notebook once with a Markdown summary. Then write the final answer using ONLY the notebook, research ledger, and source list. Cite with [N]. List remaining gaps explicitly; do not fill them with unsupported numbers or speculation.';
}

type RoundResult =
  | { kind: 'tools'; researchPerformed: boolean }
  | { kind: 'answer' }
  | { kind: 'error' };

function toPublicSource(source: SourceWithIndex): Source {
  return {
    title: source.title,
    url: source.url,
    domain: source.domain,
    snippet: source.snippet,
  };
}

/* ── Core tool-calling round ── */
async function toolCallingRound(
  messages: LLMMessage[], allSources: Map<string, SourceWithIndex>,
  steps: AgentStep[], round: number, onEvent: (ev: EngineEvent) => void,
  budget: ResearchBudgetState, maxRounds: number, onRoundProgress?: () => void,
  signal?: AbortSignal, role?: LLMRole, deepState?: DeepResearchState, preset?: ResolvedResearchPreset,
  cooldownState?: ResearchCooldownState,
): Promise<RoundResult> {
  if (signal?.aborted) return { kind: 'error' };

  const budgetExhausted = budget.remainingCredits <= 0;
  const roundsExhausted = round >= maxRounds;
  const researchExhausted = budgetExhausted || roundsExhausted;

  const stepType = round === 0 ? 'plan-analyze' : 'analyze';
  const step: AgentStep = { type: stepType, note: round === 0 ? 'Analyzing question...' : 'Thinking...' };
  steps.push(step);
  onEvent({ type: 'step', data: step });

  if (researchExhausted) {
    if (budgetExhausted) budget.exhausted = true;
    onRoundProgress?.();
    const warning = deepState
      ? (roundsExhausted ? roundsExhaustedDeepMessage() : budgetExhaustedDeepMessage())
      : `⚠️ **Research budget or rounds exhausted.** Answer based on the information you already have. If you lack sufficient data, state what you know and what is missing.`;
    messages.push({ role: 'system', content: warning });
    steps.push({ type: 'budget', note: roundsExhausted ? 'Round limit reached — model will answer from existing data.' : 'Budget exhausted — model will answer from existing data.' });
    onEvent({ type: 'step', data: steps[steps.length - 1] });
  } else {
    const remainingRoundBudget = maxRounds - round;
    const remainingCredits = budget.remainingCredits;
    if (remainingCredits <= 2) {
      const msg = `⚠️ **Low budget.** Only ${remainingCredits} credit(s) remain. Use them for your most important remaining gaps, then write your answer.`;
      messages.push({ role: 'system', content: msg });
    }
    if (remainingRoundBudget <= 1) {
      const msg = `⚠️ **Last round.** If you still have missing information, search now. Otherwise, write your comprehensive answer with citations.`;
      messages.push({ role: 'system', content: msg });
    } else if (remainingRoundBudget <= 2) {
      const msg = `⚠️ **${remainingRoundBudget} rounds remaining.** Continue researching any remaining gaps before answering.`;
      messages.push({ role: 'system', content: msg });
    }
  }

  if (deepState) {
    const uncompactedRawBlocks = countUncompactedRawResearchMessages(messages, deepState);
    const cadenceThreshold = Math.max(1, deepState.preset.notebookCadenceRawBlocks);
    const cadenceInstruction = uncompactedRawBlocks >= cadenceThreshold
      ? `\n\nBefore further search or fetch calls, call write_notebook to preserve the ${uncompactedRawBlocks} raw evidence block(s) currently still in context. This prevents context bloat and keeps the research state durable.`
      : '';
    messages.push({
      role: 'system',
      content: deepResearchContextBlock(deepState, cadenceInstruction),
    });
  }

  const temp = temperatureForRound(round);
  let llmResult: LLMResult;
  const tools = researchExhausted
    ? (deepState ? [WRITE_NOTEBOOK_TOOL, READ_NOTEBOOK_TOOL] : undefined)
    : (deepState ? [SEARCH_TOOL, FETCH_URL_TOOL, WRITE_NOTEBOOK_TOOL, READ_NOTEBOOK_TOOL] : [SEARCH_TOOL, FETCH_URL_TOOL]);
  try {
    llmResult = await callLLM({
      messages, temperature: temp, tools, toolChoice: tools ? 'auto' : 'none', role, signal,
      onModelSelected: (selectedModel) => { step.model = selectedModel; onEvent({ type: 'step', data: step }); },
      label: `tool-round-${round}`,
    });
  } catch (err: unknown) {
    onEvent({ type: 'context', finalContext: makeFinalContextJson(messages) });
    onEvent({ type: 'error', message: (err as Error).message || 'No available model responded' });
    return { kind: 'error' };
  }

  const { data, model } = llmResult;
  const d = data as { choices: { message: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; reasoning?: string; reasoning_content?: string }; finish_reason: string }[] } | undefined;
  const choice = d!.choices[0];
  const msg = choice.message;
  if (msg.content) msg.content = stripThinkingTags(msg.content);
  const finish = choice.finish_reason;
  const currentModel = model;

  const reasoningText = msg.reasoning || msg.reasoning_content;
  if (reasoningText?.trim()) step.note = reasoningText.trim();
  step.model = currentModel;
  onEvent({ type: 'step', data: step });

  if (finish === 'tool_calls' && msg.tool_calls) {
    messages.push({ role: msg.role, content: msg.content, tool_calls: msg.tool_calls });

    const searchTasks: { tcId: string; query: string; type: string; stepIndex: number }[] = [];
    const fetchTasks: { tcId: string; url: string; stepIndex: number }[] = [];
    const notebookWriteTasks: { tcId: string; args: NotebookWriteArgs }[] = [];
    const notebookReadTasks: { tcId: string; args: NotebookReadArgs }[] = [];
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown>;
      try { args = JSON.parse(tc.function.arguments); } catch { continue; }
      const tcId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      if (tc.function.name === 'write_notebook') {
        notebookWriteTasks.push({ tcId, args: args as unknown as NotebookWriteArgs });
        continue;
      }

      if (tc.function.name === 'read_notebook') {
        notebookReadTasks.push({ tcId, args: args as NotebookReadArgs });
        continue;
      }

      if (tc.function.name === 'fetch_url') {
        const url = String(args.url || '').trim();
        if (url) {
          const s: AgentStep = { type: 'webpage', query: url, model: currentModel };
          const stepIndex = steps.length;
          steps.push(s); onEvent({ type: 'step', data: s });
          fetchTasks.push({ tcId, url, stepIndex });
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
    if (totalTasks === 0 && notebookWriteTasks.length === 0 && notebookReadTasks.length === 0) {
      console.log('[tool_calls] no valid tasks found');
      for (const tc of msg.tool_calls) {
        const tcId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        messages.push({ role: 'tool', tool_call_id: tcId, content: 'Invalid tool call arguments. No results available.' });
      }
      return { kind: 'tools', researchPerformed: false };
    }
    if (deepState && notebookReadTasks.length > 0) {
      for (const task of notebookReadTasks) {
        const view = readNotebookForModel(deepState.notebook, task.args);
        messages.push({
          role: 'tool',
          tool_call_id: task.tcId,
          content: view.content,
        });
      }
    } else if (notebookReadTasks.length > 0) {
      for (const task of notebookReadTasks) {
        messages.push({ role: 'tool', tool_call_id: task.tcId, content: 'read_notebook is only available in deep research mode.' });
      }
    }

    if (deepState && notebookWriteTasks.length > 0) {
      for (const task of notebookWriteTasks) {
        try {
          const result = appendNotebookContent(deepState.notebook, task.args, round);
          const compacted = compactRawResearchMessages(messages, deepState);
          const s: AgentStep = {
            type: 'notebook',
            note: `Notebook updated: ${result.heading}${compacted > 0 ? ` (${compacted} raw context block(s) compacted)` : ''}`,
            context: deepState.notebook.path,
            model: currentModel,
          };
          steps.push(s);
          onEvent({ type: 'step', data: s });
          onRoundProgress?.();
          messages.push({
            role: 'tool',
            tool_call_id: task.tcId,
            content: JSON.stringify({
              ok: true,
              notebook_id: deepState.notebook.id,
              heading: result.heading,
              bytes_total: result.bytesTotal,
              compacted_raw_blocks: compacted,
              note: 'Markdown appended. Current working view is in the next system notebook block.',
            }),
          });
        } catch (err: unknown) {
          messages.push({
            role: 'tool',
            tool_call_id: task.tcId,
            content: (err as Error).message || 'Failed to write notebook.',
          });
        }
      }
    } else if (notebookWriteTasks.length > 0) {
      for (const task of notebookWriteTasks) {
        messages.push({ role: 'tool', tool_call_id: task.tcId, content: 'write_notebook is only available in deep research mode.' });
      }
    }

    if (totalTasks === 0) {
      return { kind: 'tools', researchPerformed: false };
    }
    if (budget.remainingCredits <= 0) {
      budget.exhausted = true; onRoundProgress?.();
      for (const tc of msg.tool_calls.filter(tc => tc.function.name !== 'write_notebook' && tc.function.name !== 'read_notebook')) {
        const tcId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        messages.push({ role: 'tool', tool_call_id: tcId, content: deepState ? budgetExhaustedDeepMessage() : 'Research budget exhausted. No results available. Write your final answer now based on the information you already have.' });
      }
      return { kind: 'tools', researchPerformed: false };
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
          const dupStep: AgentStep = { type: 'search', query: s.query, note: 'Skipped duplicate query — see research ledger', model: currentModel };
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
          const dupStep: AgentStep = { type: 'webpage', query: f.url, note: 'Skipped duplicate fetch — see research ledger', model: currentModel };
          steps.push(dupStep);
          onEvent({ type: 'step', data: dupStep });
          continue;
        }
      }
      freshFetchTasks.push(f);
    }

    const maxSearchesThisRound = preset?.mode === 'deep' ? preset.maxSearchesPerRound : budget.remainingCredits;
    const maxFetchesThisRound = preset?.mode === 'deep' ? preset.maxFetchesPerRound : budget.remainingCredits;
    const allowedSearchTasks = freshSearchTasks.slice(0, Math.min(budget.remainingCredits, maxSearchesThisRound));
    const allowedFetchTasks = freshFetchTasks.slice(0, Math.min(maxFetchesThisRound, Math.max(0, budget.remainingCredits - allowedSearchTasks.length)));
    const allowedCount = allowedSearchTasks.length + allowedFetchTasks.length;

    if (allowedCount === 0 && duplicateToolNotes.size > 0) {
      for (const [tcId, notes] of duplicateToolNotes) {
        messages.push({
          role: 'tool',
          tool_call_id: tcId,
          content: `${notes.join('\n\n')}\n\n[No credits spent — use notebook/ledger evidence and pick a new next_action.]`,
        });
      }
      onRoundProgress?.();
      return { kind: 'tools', researchPerformed: false };
    }

    if (allowedCount < totalTasks) {
      const s: AgentStep = { type: 'budget', note: `Research pacing limited this round to ${allowedCount} of ${totalTasks} requested tasks.` };
      steps.push(s); onEvent({ type: 'step', data: s });
    }

    const searchTimestamps = allowedSearchTasks.map(() => performance.now());
    const fetchTimestamps = allowedFetchTasks.map(() => performance.now());
    interface IndexedResult { id: number | null; url: string; title: string; snippet: string | null; source_index: number; date: string | null; }
    const resultsByTcId = new Map<string, IndexedResult[]>();
    const toolOutcomes: ToolOutcome[] = [];

    const searchPromises = allowedSearchTasks.map((s, i) =>
      fetchResults(s.query, s.type, signal, role === 'instant' ? 5 : undefined).then(({ results }) => {
        const step = steps[s.stepIndex];
        step.duration_ms = Math.round(performance.now() - searchTimestamps[i]);
        step.result_count = results.length;
        toolOutcomes.push({ ok: true, latencyMs: step.duration_ms });
        onEvent({ type: 'step', data: step });
        const topUrls = results.map(r => r.url);
        if (deepState) recordLedgerSearch(deepState.ledger, s.query, round, results.length, topUrls);
        for (const r of results) {
          if (!allSources.has(r.url)) {
            allSources.set(r.url, { title: r.title, url: r.url, domain: domain(r.url), snippet: r.snippet, source_index: allSources.size + 1 });
          }
        }
        if (!resultsByTcId.has(s.tcId)) resultsByTcId.set(s.tcId, []);
        resultsByTcId.get(s.tcId)!.push(...results.map(r => ({ ...r, source_index: allSources.get(r.url)?.source_index ?? 0 })));
        onEvent({ type: 'sources', sources: Array.from(allSources.values()).map(toPublicSource) });
      }).catch((err: unknown) => {
        const step = steps[s.stepIndex];
        step.duration_ms = Math.round(performance.now() - searchTimestamps[i]);
        const message = (err as Error).message || 'Search failed';
        step.note = message;
        toolOutcomes.push({ ok: false, latencyMs: step.duration_ms, is429: message.includes('429') });
        onEvent({ type: 'step', data: step });
        return { results: [] as { title: string; url: string; snippet: string | null }[] };
      })
    );

    const fetchPromises = allowedFetchTasks.map((f, i) =>
      fetchPageContent(f.url, signal).then(({ title, content, error }) => {
        const step = steps[f.stepIndex];
        step.duration_ms = Math.round(performance.now() - fetchTimestamps[i]);
        toolOutcomes.push({ ok: !error, latencyMs: step.duration_ms });
        if (error) {
          step.note = `Could not read page (${error})`; onEvent({ type: 'step', data: step });
          if (deepState) recordLedgerFetch(deepState.ledger, f.url, round, false, f.url);
          if (!resultsByTcId.has(f.tcId)) resultsByTcId.set(f.tcId, []);
          resultsByTcId.get(f.tcId)!.push({ id: 0, title: f.url, url: f.url, source_index: 0, snippet: `This page could not be fetched: ${error}`, date: null });
          return;
        }
        step.note = title || ''; onEvent({ type: 'step', data: step });
        if (deepState) recordLedgerFetch(deepState.ledger, f.url, round, true, title || f.url);
        if (!allSources.has(f.url)) {
          allSources.set(f.url, { title: title || f.url, url: f.url, domain: domain(f.url), snippet: content.slice(0, 500), source_index: allSources.size + 1 });
        }
        const idx = allSources.get(f.url)?.source_index ?? 0;
        if (!resultsByTcId.has(f.tcId)) resultsByTcId.set(f.tcId, []);
        resultsByTcId.get(f.tcId)!.push({ id: idx, title: title || f.url, url: f.url, source_index: idx, snippet: content.slice(0, 3000), date: null });
        onEvent({ type: 'sources', sources: Array.from(allSources.values()).map(toPublicSource) });
      })
    );

    await Promise.all([...searchPromises, ...fetchPromises]);

    const cooldownOk = await applyResearchCooldown(preset, cooldownState, toolOutcomes, round, maxRounds, steps, onEvent, signal);
    if (!cooldownOk) return { kind: 'error' };

    for (const [tcId, indexedResults] of resultsByTcId.entries()) {
      const seenUrls = new Set<string>();
      const dedupedResults = indexedResults.filter((r) => { if (seenUrls.has(r.url)) return false; seenUrls.add(r.url); return true; });
      const textList = dedupedResults.map((r, index: number) =>
        `${index + 1}. [Source #${r.source_index}] Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet || 'No content'}`
      ).join('\n\n');
      const duplicatePrefix = duplicateToolNotes.get(tcId)?.join('\n\n');
      const body = [duplicatePrefix, textList].filter(Boolean).join('\n\n');
      const remaining = Math.max(0, budget.remainingCredits - allowedCount);
      const budgetNote = remaining > 0
        ? `\n\n[You have ${remaining} search/fetch credits remaining for this research. Use them wisely.]`
        : `\n\n[${deepState ? budgetExhaustedDeepMessage() : 'Your research budget for this query is exhausted. Write your final answer now using the information above.'}]`;
      messages.push({ role: 'tool', tool_call_id: tcId, content: body + budgetNote });
    }

    for (const [tcId, notes] of duplicateToolNotes) {
      if (resultsByTcId.has(tcId)) continue;
      messages.push({
        role: 'tool',
        tool_call_id: tcId,
        content: `${notes.join('\n\n')}\n\n[No credits spent — use notebook/ledger evidence and pick a new next_action.]`,
      });
    }

    budget.usedCredits += allowedCount;
    budget.remainingCredits -= allowedCount;
    if (budget.remainingCredits <= 0) budget.exhausted = true;
    onRoundProgress?.();
    messages.push({ role: 'system', content: `[Budget: ${budget.remainingCredits} credits remaining | Round ${round + 1}/${maxRounds}]` });
    return { kind: 'tools', researchPerformed: allowedCount > 0 };
  }

  /* Inline tool call */
  const content = msg.content || '';
  const inlineCall = parseInlineToolCall(content);
  if (inlineCall) {
    if (researchExhausted) {
      messages.push({ role: msg.role, content: content.replace(inlineCall.raw, '').trim() || null });
      messages.push({ role: 'tool', tool_call_id: `call_inline_${Date.now()}`, content: roundsExhausted ? 'Research rounds limit reached. No results available. Write your final answer now based on the information you already have.' : 'Research budget exhausted. No results available. Write your final answer now based on the information you already have.' });
      return { kind: 'tools', researchPerformed: false };
    }
    const allQueries = inlineCall.queries?.length ? inlineCall.queries : [(inlineCall.query || '').trim()].filter(Boolean);
    if (allQueries.length > 0) {
      console.log(`[inline tool] parsed ${allQueries.length} query(s):`, allQueries);
      messages.push({ role: msg.role, content: content.replace(inlineCall.raw, '').trim() || null });

      const maxInlineQueries = preset?.mode === 'deep' ? preset.maxSearchesPerRound : budget.remainingCredits;
      const inlineDuplicateNotes: string[] = [];
      const freshInlineQueries: string[] = [];
      for (const q of allQueries) {
        if (deepState) {
          const prior = findPriorSearch(deepState.ledger, q);
          if (prior) {
            inlineDuplicateNotes.push(duplicateSearchToolMessage(prior));
            const dupStep: AgentStep = { type: 'search', query: q, note: 'Skipped duplicate query — see research ledger', model: currentModel };
            steps.push(dupStep);
            onEvent({ type: 'step', data: dupStep });
            continue;
          }
        }
        freshInlineQueries.push(q);
      }
      const allowedQueries = freshInlineQueries.slice(0, Math.min(budget.remainingCredits, maxInlineQueries));
      if (allowedQueries.length < allQueries.length) budget.exhausted = true;
      const tcId = `call_inline_${Date.now()}`;
      if (allowedQueries.length === 0 && inlineDuplicateNotes.length > 0) {
        messages.push({
          role: 'tool',
          tool_call_id: tcId,
          content: `${inlineDuplicateNotes.join('\n\n')}\n\n[No credits spent — use notebook/ledger evidence.]`,
        });
        onRoundProgress?.();
        return { kind: 'tools', researchPerformed: false };
      }
      const queryTimestamps = allowedQueries.map(() => performance.now());
      const queryStepIndices: number[] = [];
      const inlineOutcomes: ToolOutcome[] = [];

      for (const q of allowedQueries) {
        const qStep: AgentStep = { type: 'search', query: q, model: currentModel };
        queryStepIndices.push(steps.length);
        steps.push(qStep); onEvent({ type: 'step', data: qStep });
      }

      const allResults = (await Promise.all(allowedQueries.map(async (q, i) => {
        try {
          const { results } = await fetchResults(q, 'search', signal, role === 'instant' ? 5 : undefined);
          const qStep = steps[queryStepIndices[i]];
          qStep.duration_ms = Math.round(performance.now() - queryTimestamps[i]);
          qStep.result_count = results.length;
          inlineOutcomes.push({ ok: true, latencyMs: qStep.duration_ms });
          onEvent({ type: 'step', data: qStep });
          if (deepState) recordLedgerSearch(deepState.ledger, q, round, results.length, results.map(r => r.url));
          return results;
        } catch (err: unknown) {
          const qStep = steps[queryStepIndices[i]];
          qStep.duration_ms = Math.round(performance.now() - queryTimestamps[i]);
          const message = (err as Error).message || 'Search failed';
          inlineOutcomes.push({ ok: false, latencyMs: qStep.duration_ms, is429: message.includes('429') });
          qStep.note = message;
          onEvent({ type: 'step', data: qStep });
          return [];
        }
      }))).flat();

      const cooldownOk = await applyResearchCooldown(preset, cooldownState, inlineOutcomes, round, maxRounds, steps, onEvent, signal);
      if (!cooldownOk) return { kind: 'error' };

      for (const r of allResults) {
        if (!allSources.has(r.url)) {
          allSources.set(r.url, { title: r.title, url: r.url, domain: domain(r.url), snippet: r.snippet, source_index: allSources.size + 1 });
        }
      }

      const seenUrls = new Set<string>();
      const dedupedResults = allResults.filter(r => { if (seenUrls.has(r.url)) return false; seenUrls.add(r.url); return true; });
      const textList = dedupedResults.map((r, index) => {
        const idx = allSources.get(r.url)?.source_index ?? 0;
        return `${index + 1}. [Source #${idx}] Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet || 'No content'}`;
      }).join('\n\n');
      const rem = Math.max(0, budget.remainingCredits - allowedQueries.length);
      const note = rem > 0
        ? `\n\n[You have ${rem} search/fetch credits remaining.]`
        : `\n\n[${deepState ? budgetExhaustedDeepMessage() : 'Your research budget is exhausted. Write your final answer now.'}]`;
      const inlineBody = [inlineDuplicateNotes.join('\n\n'), textList].filter(Boolean).join('\n\n');
      messages.push({ role: 'tool', tool_call_id: tcId, content: inlineBody + note });

      budget.usedCredits += allowedQueries.length;
      budget.remainingCredits -= allowedQueries.length;
      if (budget.remainingCredits <= 0) budget.exhausted = true;
      onRoundProgress?.();
      messages.push({ role: 'system', content: `[Budget: ${budget.remainingCredits} credits remaining | Round ${round + 1}/${maxRounds}]` });
      onEvent({ type: 'sources', sources: Array.from(allSources.values()).map(toPublicSource) });
      return { kind: 'tools', researchPerformed: allowedQueries.length > 0 };
    }
  }

  /* Model answered — no tool calls, direct response */
  const finalStep: AgentStep = { type: 'answer' };
  steps.push(finalStep);
  onEvent({ type: 'step', data: finalStep });
  messages.push({ role: msg.role, content: msg.content });
  return { kind: 'answer' };
}

function compactRawResearchMessages(messages: LLMMessage[], deepState: DeepResearchState): number {
  let compacted = 0;
  for (let i = deepState.lastCompactedMessageIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    if (!msg.content.includes('Source #')) continue;
    const previewUrls = extractSourceUrlsFromToolContent(msg.content).join(', ');
    msg.content = compactedEvidenceNote(deepState.notebook.id, previewUrls || msg.content.slice(0, 200));
    compacted++;
  }
  deepState.lastCompactedMessageIndex = messages.length;
  return compacted;
}

function countUncompactedRawResearchMessages(messages: LLMMessage[], deepState: DeepResearchState): number {
  let count = 0;
  for (let i = deepState.lastCompactedMessageIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.includes('Source #')) {
      count++;
    }
  }
  return count;
}

async function applyResearchCooldown(
  preset: ResolvedResearchPreset | undefined,
  cooldownState: ResearchCooldownState | undefined,
  toolOutcomes: ToolOutcome[],
  round: number,
  maxRounds: number,
  steps: AgentStep[],
  onEvent: (ev: EngineEvent) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!preset || preset.mode !== 'deep' || !cooldownState) return true;
  if (toolOutcomes.length > 0) recordToolOutcomes(cooldownState, toolOutcomes);
  if (toolOutcomes.length === 0) return true;
  const rateSignals = consumeRateSignalsForCooldown();
  const { ms, reason } = computeCooldownMs({
    preset,
    state: cooldownState,
    remainingRounds: maxRounds - round,
    providerPressure: rateSignals.providerPressure,
    retryAfterMs: rateSignals.retryAfterMs,
  });
  cooldownState.lastCooldownMs = ms;
  return waitCooldown(ms, reason, signal, (note) => {
    const s: AgentStep = { type: 'cooldown', note };
    steps.push(s);
    onEvent({ type: 'step', data: s });
  });
}

/* ── Agentic research loop ── */
export async function agenticResearchStream(
  query: string,
  history: { role: string; content: string }[] | undefined,
  onEvent: (event: EngineEvent) => void,
  mode: 'quick' | 'deep' = 'quick',
  options: ResearchRunOptions = {},
): Promise<void> {
  const settings = loadSettings();
  const preset = options.preset ?? resolveResearchPreset(mode, options.depth, settings);
  const start = performance.now();
  const steps: AgentStep[] = [];
  const allSources = new Map<string, SourceWithIndex>();
  let deepState: DeepResearchState | undefined = mode === 'deep'
    ? { notebook: createNotebook(query), ledger: createResearchLedger(), lastCompactedMessageIndex: 0, preset }
    : undefined;
  const maxRounds = preset.maxRounds;
  const budget: ResearchBudgetState = {
    remainingCredits: Math.max(0, Math.min(
      options.budget?.remainingCredits ?? preset.budgetCredits,
      preset.budgetCredits,
    )),
    usedCredits: options.budget?.usedCredits ?? 0,
    exhausted: options.budget?.exhausted ?? false,
  };

  let startRound = 0;
  if (options.jobId && mode === 'deep') {
    const checkpoint = loadResearchCheckpoint(options.jobId);
    if (checkpoint && checkpoint.depth === preset.depth) {
      budget.usedCredits = checkpoint.usedCredits;
      budget.remainingCredits = checkpoint.remainingCredits;
      budget.exhausted = checkpoint.remainingCredits <= 0;
      startRound = checkpoint.round;
      for (const source of checkpoint.sourceMap) {
        allSources.set(source.url, source);
      }
      const notebook = loadNotebook(checkpoint.notebookId);
      if (notebook) {
        deepState = { notebook, ledger: createResearchLedger(), lastCompactedMessageIndex: 0, preset };
      }
      const resumeStep: AgentStep = {
        type: 'checkpoint',
        note: `Resumed from checkpoint at round ${startRound} (${budget.remainingCredits} credits remaining).`,
      };
      steps.push(resumeStep);
      onEvent({ type: 'step', data: resumeStep });
    }
  }
  const now = new Date();
  const today = `${now.toLocaleDateString('en-US', { month: 'long' })} ${now.getDate()}, ${now.getFullYear()}`;
  const constraintsBlock = mode === 'deep'
    ? `\n\n**Research budget and notebook:** You have ${budget.remainingCredits} search/fetch credits. Use the deep research notebook as your working memory: write durable notes after each evidence batch, track unresolved gaps, and continue only with targeted searches. Do not conserve credits when material gaps remain. Do not write the final answer until the notebook shows the user's material requirements are resolved or the budget is exhausted.${startRound > 0 ? `\n\n**Resume:** This job resumed from round ${startRound}. Use the notebook state and cited sources; do not repeat completed research unless a gap reopened.` : ''}`
    : `\n\n**Research constraints:** You have ${budget.remainingCredits} search/fetch credits and a maximum of ${maxRounds} rounds. Each search or fetch costs 1 credit. Plan your research — when credits or rounds run low, stop searching and write your answer using what you have.`;
  const systemPrompt = (mode === 'deep' ? DEEP_SYSTEM_PROMPT : SYSTEM_PROMPT) + `\n\n**Today's date:** ${today}.` + constraintsBlock + depthBehaviorBlock(preset);
  const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];
  const sanitizedHistory = sanitizeHistory(history, query, mode);
  if (sanitizedHistory.length > 0) messages.push(...sanitizedHistory.map(h => ({ role: h.role, content: h.content })));
  messages.push({ role: 'user', content: query });
  const activeRole = mode === 'quick' ? 'instant' : 'deep';
  const sessionStartIdx = messages.length;
  const cooldownState = createCooldownState();

  const publishProgress = (roundNum: number) => {
    options.onProgress?.({
      ...budget,
      round: roundNum,
      depth: preset.mode === 'deep' ? preset.depth : undefined,
      notebookId: deepState?.notebook.id,
      notebookUpdates: deepState?.notebook.appendCount ?? 0,
      sourceMap: Array.from(allSources.values()),
    });
  };

  let hadError = false;
  let round = startRound;
  let totalTurns = 0;
  const maxTotalTurns = Math.max(50, maxRounds * 3);

  while (!hadError && round < maxRounds + 3 && totalTurns < maxTotalTurns) {
    if (options.signal?.aborted) break;
    const result = await toolCallingRound(messages, allSources, steps, round, onEvent, budget, maxRounds, () => publishProgress(round), options.signal, activeRole, deepState, preset, cooldownState);
    if (result.kind === 'error') { hadError = true; break; }
    if (result.kind === 'answer') break;
    if (
      options.jobId && deepState && preset.checkpointEveryRounds > 0
      && (round + 1) % preset.checkpointEveryRounds === 0
    ) {
      saveResearchCheckpoint({
        jobId: options.jobId,
        query,
        depth: preset.depth,
        preset,
        notebookId: deepState.notebook.id,
        usedCredits: budget.usedCredits,
        remainingCredits: budget.remainingCredits,
        round: round + 1,
        sourceMap: Array.from(allSources.values()),
        lastUpdatedAt: new Date().toISOString(),
      });
      const checkpointStep: AgentStep = {
        type: 'checkpoint',
        note: `Checkpoint saved at round ${round + 1}.`,
        context: deepState.notebook.path,
      };
      steps.push(checkpointStep);
      onEvent({ type: 'step', data: checkpointStep });
    }
    if (result.kind === 'tools') {
      if (result.researchPerformed) {
        round++;
      }
    }
    totalTurns++;
    publishProgress(round);
  }

  if (hadError || options.signal?.aborted) return;

  function finalContextJson(): string {
    return makeFinalContextJson(messages);
  }

  const finalSources: Source[] = Array.from(allSources.values()).map(toPublicSource);
  if (deepState) persistNotebook(deepState.notebook);
  const sessionMessages = messages.slice(sessionStartIdx);
  const answerMsg = sessionMessages
    .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim() && !parseInlineToolCall(m.content))
    .pop();

  if (answerMsg?.content) {
    const elapsed = Math.round(performance.now() - start);
    if (options.jobId) deleteResearchCheckpoint(options.jobId);
    onEvent({ type: 'token', text: answerMsg.content });
    onEvent({ type: 'context', finalContext: finalContextJson() });
    onEvent({ type: 'done', response: { query, answer: answerMsg.content, sources: finalSources, steps, results_count: allSources.size, elapsed_ms: elapsed, research_budget: { used: budget.usedCredits, limit: budget.usedCredits + budget.remainingCredits, exhausted: budget.exhausted }, research_depth: mode === 'deep' ? preset.depth : undefined, research_notebook: deepState ? { id: deepState.notebook.id, path: deepState.notebook.path, updates: deepState.notebook.appendCount, updatedAt: deepState.notebook.updatedAt } : undefined } as SearchResponse });
    return;
  }

  if (allSources.size > 0) {
    onEvent({ type: 'context', finalContext: finalContextJson() });
    onEvent({ type: 'error', message: budget.exhausted ? 'Araştırma bütçesi doldu ancak model cevap üretemedi.' : 'Model tüm turları kullandı ancak cevap üretemedi.' });
  } else {
    onEvent({ type: 'context', finalContext: finalContextJson() });
    onEvent({ type: 'error', message: 'Model could not produce an answer.' });
  }
}
