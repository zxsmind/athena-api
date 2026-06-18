import { callLLM, stripThinkingTags, type LLMRole } from './llm.js';
import type { LLMResult } from './llm.js';
import { fetchResults, fetchPageContent } from './search.js';
import type { SearchResponse, Source, AgentStep } from './schemas.js';
import { SYSTEM_PROMPT, DEEP_SYSTEM_PROMPT } from './agent/prompts.js';
import { loadSettings } from './settings-store.js';
import { SEARCH_TOOL, FETCH_URL_TOOL, type EngineEvent, type ResearchBudgetState, type ResearchRunOptions, type SourceWithIndex } from './engine/types.js';
import { temperatureForRound, sanitizeHistory, domain } from './engine/history.js';
import { parseInlineToolCall } from './engine/tool-parser.js';

export type { EngineEvent, ResearchRunOptions, ResearchBudgetState } from './engine/types.js';

interface LLMMessage {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
}

type RoundResult =
  | { kind: 'tools' }
  | { kind: 'answer' }
  | { kind: 'error' };

/* ── Core tool-calling round ── */
async function toolCallingRound(
  messages: LLMMessage[], allSources: Map<string, SourceWithIndex>,
  steps: AgentStep[], round: number, onEvent: (ev: EngineEvent) => void,
  budget: ResearchBudgetState, maxRounds: number, onProgress?: (state: ResearchBudgetState) => void,
  signal?: AbortSignal, role?: LLMRole,
): Promise<RoundResult> {
  if (signal?.aborted) return { kind: 'error' };

  const budgetExhausted = budget.remainingCredits <= 0;

  const stepType = round === 0 ? 'plan-analyze' : 'analyze';
  const step: AgentStep = { type: stepType, note: round === 0 ? 'Analyzing question...' : 'Thinking...' };
  steps.push(step);
  onEvent({ type: 'step', data: step });

  if (budgetExhausted) {
    budget.exhausted = true;
    onProgress?.(budget);
    const warning = `⚠️ **Research budget exhausted.** You have no remaining search or fetch credits. Answer based on the information you already have. If you lack sufficient data, state what you know and what is missing.`;
    messages.push({ role: 'system', content: warning });
    steps.push({ type: 'budget', note: 'Budget exhausted — model will answer from existing data.' });
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

  const temp = temperatureForRound(round);
  let llmResult: LLMResult;
  try {
    llmResult = await callLLM({
      messages, temperature: temp, tools: budgetExhausted ? undefined : [SEARCH_TOOL, FETCH_URL_TOOL], toolChoice: budgetExhausted ? 'none' : 'auto', role, signal,
      onModelSelected: (selectedModel) => { step.model = selectedModel; onEvent({ type: 'step', data: step }); },
      label: `tool-round-${round}`,
    });
  } catch (err: unknown) {
    onEvent({ type: 'error', message: (err as Error).message || 'No available model responded', finalContext: JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })).filter((m): m is { role: string; content: string } => typeof m.content === 'string' && m.content.length > 0), null, 2) });
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
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown>;
      try { args = JSON.parse(tc.function.arguments); } catch { continue; }
      const tcId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

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
    if (totalTasks === 0) {
      console.log('[tool_calls] no valid tasks found');
      for (const tc of msg.tool_calls) {
        const tcId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        messages.push({ role: 'tool', tool_call_id: tcId, content: 'Invalid tool call arguments. No results available.' });
      }
      return { kind: 'tools' };
    }
    if (budget.remainingCredits <= 0) {
      budget.exhausted = true; onProgress?.(budget);
      for (const tc of msg.tool_calls) {
        const tcId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        messages.push({ role: 'tool', tool_call_id: tcId, content: 'Research budget exhausted. No results available. Write your final answer now based on the information you already have.' });
      }
      return { kind: 'tools' };
    }

    const allowedSearchTasks = searchTasks.slice(0, budget.remainingCredits);
    const allowedFetchTasks = fetchTasks.slice(0, Math.max(0, budget.remainingCredits - allowedSearchTasks.length));
    const allowedCount = allowedSearchTasks.length + allowedFetchTasks.length;

    if (allowedCount < totalTasks) {
      const s: AgentStep = { type: 'budget', note: `Research budget limited this round to ${allowedCount} of ${totalTasks} requested tasks.` };
      steps.push(s); onEvent({ type: 'step', data: s });
      budget.exhausted = true;
    }

    const searchTimestamps = allowedSearchTasks.map(() => performance.now());
    const fetchTimestamps = allowedFetchTasks.map(() => performance.now());
    interface IndexedResult { id: number | null; url: string; title: string; snippet: string | null; source_index: number; date: string | null; }
    const resultsByTcId = new Map<string, IndexedResult[]>();

    const searchPromises = allowedSearchTasks.map((s, i) =>
      fetchResults(s.query, s.type, signal, role === 'instant' ? 5 : undefined).then(({ results }) => {
        const step = steps[s.stepIndex];
        step.duration_ms = Math.round(performance.now() - searchTimestamps[i]);
        step.result_count = results.length;
        onEvent({ type: 'step', data: step });
        for (const r of results) {
          if (!allSources.has(r.url)) {
            allSources.set(r.url, { title: r.title, url: r.url, domain: domain(r.url), snippet: r.snippet, source_index: allSources.size + 1 });
          }
        }
        if (!resultsByTcId.has(s.tcId)) resultsByTcId.set(s.tcId, []);
        resultsByTcId.get(s.tcId)!.push(...results.map(r => ({ ...r, source_index: allSources.get(r.url)?.source_index ?? 0 })));
        onEvent({ type: 'sources', sources: Array.from(allSources.values()).map(({ source_index, ...s }) => s as Source) });
      })
    );

    const fetchPromises = allowedFetchTasks.map((f, i) =>
      fetchPageContent(f.url, signal).then(({ title, content, error }) => {
        const step = steps[f.stepIndex];
        step.duration_ms = Math.round(performance.now() - fetchTimestamps[i]);
        if (error) {
          step.note = `Could not read page (${error})`; onEvent({ type: 'step', data: step });
          if (!resultsByTcId.has(f.tcId)) resultsByTcId.set(f.tcId, []);
          resultsByTcId.get(f.tcId)!.push({ id: 0, title: f.url, url: f.url, source_index: 0, snippet: `This page could not be fetched: ${error}`, date: null });
          return;
        }
        step.note = title || ''; onEvent({ type: 'step', data: step });
        if (!allSources.has(f.url)) {
          allSources.set(f.url, { title: title || f.url, url: f.url, domain: domain(f.url), snippet: content.slice(0, 500), source_index: allSources.size + 1 });
        }
        const idx = allSources.get(f.url)?.source_index ?? 0;
        if (!resultsByTcId.has(f.tcId)) resultsByTcId.set(f.tcId, []);
        resultsByTcId.get(f.tcId)!.push({ id: idx, title: title || f.url, url: f.url, source_index: idx, snippet: content.slice(0, 3000), date: null });
        onEvent({ type: 'sources', sources: Array.from(allSources.values()).map(({ source_index, ...s }) => s as Source) });
      })
    );

    await Promise.all([...searchPromises, ...fetchPromises]);

    for (const [tcId, indexedResults] of resultsByTcId.entries()) {
      const seenUrls = new Set<string>();
      const dedupedResults = indexedResults.filter((r) => { if (seenUrls.has(r.url)) return false; seenUrls.add(r.url); return true; });
      const textList = dedupedResults.map((r, index: number) =>
        `${index + 1}. [Source #${r.source_index}] Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet || 'No content'}`
      ).join('\n\n');
      const remaining = Math.max(0, budget.remainingCredits - allowedCount);
      const budgetNote = remaining > 0 ? `\n\n[You have ${remaining} search/fetch credits remaining for this research. Use them wisely.]` : '\n\n[Your research budget for this query is exhausted. Write your final answer now using the information above.]';
      messages.push({ role: 'tool', tool_call_id: tcId, content: textList + budgetNote });
    }

    budget.usedCredits += allowedCount;
    budget.remainingCredits -= allowedCount;
    if (budget.remainingCredits <= 0) budget.exhausted = true;
    onProgress?.(budget);
    messages.push({ role: 'system', content: `[Budget: ${budget.remainingCredits} credits remaining | Round ${round + 1}/${maxRounds}]` });
    return { kind: 'tools' };
  }

  /* Inline tool call */
  const content = msg.content || '';
  const inlineCall = parseInlineToolCall(content);
  if (inlineCall) {
    if (budgetExhausted) {
      messages.push({ role: msg.role, content: content.replace(inlineCall.raw, '').trim() || null });
      messages.push({ role: 'tool', tool_call_id: `call_inline_${Date.now()}`, content: 'Research budget exhausted. No results available. Write your final answer now based on the information you already have.' });
      return { kind: 'tools' };
    }
    const allQueries = inlineCall.queries?.length ? inlineCall.queries : [(inlineCall.query || '').trim()].filter(Boolean);
    if (allQueries.length > 0) {
      console.log(`[inline tool] parsed ${allQueries.length} query(s):`, allQueries);
      messages.push({ role: msg.role, content: content.replace(inlineCall.raw, '').trim() || null });

      const allowedQueries = allQueries.slice(0, budget.remainingCredits);
      if (allowedQueries.length < allQueries.length) budget.exhausted = true;
      const tcId = `call_inline_${Date.now()}`;
      const queryTimestamps = allowedQueries.map(() => performance.now());
      const queryStepIndices: number[] = [];

      for (const q of allowedQueries) {
        const qStep: AgentStep = { type: 'search', query: q, model: currentModel };
        queryStepIndices.push(steps.length);
        steps.push(qStep); onEvent({ type: 'step', data: qStep });
      }

      const allResults = (await Promise.all(allowedQueries.map(async (q, i) => {
        const { results } = await fetchResults(q, 'search', signal, role === 'instant' ? 5 : undefined);
        const qStep = steps[queryStepIndices[i]];
        qStep.duration_ms = Math.round(performance.now() - queryTimestamps[i]);
        qStep.result_count = results.length;
        onEvent({ type: 'step', data: qStep });
        return results;
      }))).flat();

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
      const note = rem > 0 ? `\n\n[You have ${rem} search/fetch credits remaining.]` : '\n\n[Your research budget is exhausted. Write your final answer now.]';
      messages.push({ role: 'tool', tool_call_id: tcId, content: textList + note });

      budget.usedCredits += allowedQueries.length;
      budget.remainingCredits -= allowedQueries.length;
      if (budget.remainingCredits <= 0) budget.exhausted = true;
      onProgress?.(budget);
      messages.push({ role: 'system', content: `[Budget: ${budget.remainingCredits} credits remaining | Round ${round + 1}/${maxRounds}]` });
      onEvent({ type: 'sources', sources: Array.from(allSources.values()).map(({ source_index, ...s }) => s as Source) });
      return { kind: 'tools' };
    }
  }

  /* Model answered — no tool calls, direct response */
  const finalStep: AgentStep = { type: 'answer' };
  steps.push(finalStep);
  onEvent({ type: 'step', data: finalStep });
  messages.push({ role: msg.role, content: msg.content });
  return { kind: 'answer' };
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
  const start = performance.now();
  const steps: AgentStep[] = [];
  const allSources = new Map<string, SourceWithIndex>();
  const maxRounds = mode === 'deep' ? 50 : 3;
  const budget: ResearchBudgetState = {
    remainingCredits: Math.max(0, Math.min(
      options.budget?.remainingCredits ?? settings.research.maxCreditsPerQuery,
      mode === 'quick' ? 6 : settings.research.maxCreditsPerQuery,
    )),
    usedCredits: options.budget?.usedCredits ?? 0,
    exhausted: options.budget?.exhausted ?? false,
  };
  const now = new Date();
  const today = `${now.toLocaleDateString('en-US', { month: 'long' })} ${now.getDate()}, ${now.getFullYear()}`;
  const constraintsBlock = mode === 'deep'
    ? `\n\n**Research budget:** You have ${budget.remainingCredits} searches available. Use them all — more searches mean more verified data. Do not conserve credits. Do not stop early. Search until you have verified every component of the question or until your budget is fully consumed.`
    : `\n\n**Research constraints:** You have ${budget.remainingCredits} search/fetch credits and a maximum of ${maxRounds} rounds. Each search or fetch costs 1 credit. Plan your research — when credits or rounds run low, stop searching and write your answer using what you have.`;
  const systemPrompt = (mode === 'deep' ? DEEP_SYSTEM_PROMPT : SYSTEM_PROMPT) + `\n\n**Today's date:** ${today}.` + constraintsBlock;
  const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];
  const sanitizedHistory = sanitizeHistory(history, query, mode);
  if (sanitizedHistory.length > 0) messages.push(...sanitizedHistory.map(h => ({ role: h.role, content: h.content })));
  messages.push({ role: 'user', content: query });
  const activeRole = mode === 'quick' ? 'instant' : 'deep';
  const sessionStartIdx = messages.length;

  let hadError = false;
  let round = 0;
  while (round < maxRounds || (budget.exhausted && !hadError)) {
    if (options.signal?.aborted) break;
    const result = await toolCallingRound(messages, allSources, steps, round, onEvent, budget, maxRounds, options.onProgress, options.signal, activeRole);
    if (result.kind === 'error') { hadError = true; break; }
    if (result.kind === 'answer') break;
    round++;
    // Safety: if budget exhausted, cap extra answer attempts to 3 rounds
    if (budget.exhausted && round >= maxRounds + 3) break;
  }

  if (hadError || options.signal?.aborted) return;

  function finalContextJson(): string {
    return JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })).filter((m): m is { role: string; content: string } => typeof m.content === 'string' && m.content.length > 0), null, 2);
  }

  const finalSources: Source[] = Array.from(allSources.values()).map(({ source_index, ...s }) => s as Source);
  const sessionMessages = messages.slice(sessionStartIdx);
  const answerMsg = sessionMessages
    .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim() && !parseInlineToolCall(m.content))
    .pop();

  if (answerMsg?.content) {
    const elapsed = Math.round(performance.now() - start);
    onEvent({ type: 'token', text: answerMsg.content });
    onEvent({ type: 'done', response: { query, answer: answerMsg.content, sources: finalSources, steps, results_count: allSources.size, elapsed_ms: elapsed, research_budget: { used: budget.usedCredits, limit: budget.usedCredits + budget.remainingCredits, exhausted: budget.exhausted }, finalContext: finalContextJson() } as SearchResponse });
    return;
  }

  if (allSources.size > 0) {
    onEvent({ type: 'error', message: budget.exhausted ? 'Araştırma bütçesi doldu ancak model cevap üretemedi.' : 'Model tüm turları kullandı ancak cevap üretemedi.', finalContext: finalContextJson() });
  } else {
    onEvent({ type: 'error', message: 'Model could not produce an answer.', finalContext: finalContextJson() });
  }
}
