import { initLLM, callLLM, callLLMStream, type LLMRole } from './llm.js';
import { fetchResults, fetchPageContent } from './search.js';
import type { SearchResponse, Source, AgentStep } from './schemas.js';
import { SYSTEM_PROMPT, SYNTHESIS_PROMPT, DEEP_SYSTEM_PROMPT } from './agent/prompts.js';
import { loadSettings } from './settings-store.js';

initLLM();

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for real-time information. Generate compact retrieval phrases, not conversational questions. User-provided entities are source-of-truth text: preserve names, model numbers, versions, dates, acronyms, codes, quoted terms, and numeric constraints exactly. If an entity is unfamiliar or surprising, search it as written and verify it rather than replacing it with a familiar neighbor. Choose query language by source availability for surrounding retrieval terms. Break distinct information needs into separate queries.',
    parameters: {
      type: 'object',
      properties: {
        search_query: {
          type: 'string',
          description: 'A compact search phrase for one evidence need. Preserve user-provided entity text exactly; improve only the surrounding retrieval context.',
        },
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple compact search phrases, one per distinct evidence need. Use this when the question has multiple aspects or needs corroboration from different source types.',
        },
        type: {
          type: 'string',
          enum: ['search', 'news', 'images', 'videos', 'places', 'shopping', 'scholar', 'patents'],
          description: 'Type of search to perform. Default is "search" (general web). Use "news" for recent news, "images" for images, "videos" for videos, "places" for local businesses, "shopping" for product prices, "scholar" for academic papers.',
        },
      },
    },
  },
} as const;

const FETCH_URL_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description: 'Fetch and read the full content of a specific web page. Use this when you need details beyond a search snippet — e.g. official documentation, a specific article, or a page the user linked. Pass the full URL including https://.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch, including https://',
        },
      },
      required: ['url'],
    },
  },
} as const;

function temperatureForRound(round: number): number {
  if (round === 0) return 0.3;
  return 0.1;
}

type SourceWithIndex = Source & { source_index: number };

type TokenCb = (text: string) => void;

interface ResearchBudgetState {
  remainingCredits: number;
  usedCredits: number;
  exhausted: boolean;
}

export interface ResearchRunOptions {
  budget?: Partial<ResearchBudgetState>;
  onProgress?: (state: ResearchBudgetState) => void;
  signal?: AbortSignal;
}

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function sanitizeHistory(
  history: { role: string; content: string }[] | undefined,
  currentQuery: string,
  mode: 'quick' | 'deep',
): { role: 'user' | 'assistant'; content: string }[] {
  if (!history?.length) return [];

  const current = normalizeContent(currentQuery);
  const clean = history
    .filter((h): h is { role: 'user' | 'assistant'; content: string } =>
      (h.role === 'user' || h.role === 'assistant') &&
      typeof h.content === 'string' &&
      h.content.trim().length > 0 &&
      !h.content.startsWith('[Search result')
    );

  // Defensive guard: older clients accidentally included the current turn in history
  // while also sending it as `query`, which makes the model answer the turn twice.
  while (
    clean.length > 0 &&
    clean[clean.length - 1].role === 'user' &&
    normalizeContent(clean[clean.length - 1].content) === current
  ) {
    clean.pop();
  }

  if (mode === 'quick') {
    const users = clean.filter(h => h.role === 'user').slice(-3);
    const assts = clean.filter(h => h.role === 'assistant').slice(-3);
    const kept = new Set([...users, ...assts]);
    return clean.filter(h => kept.has(h));
  }

  return clean.slice(-12);
}

function compactHistoryForSynthesis(history: { role: 'user' | 'assistant'; content: string }[]): string {
  if (history.length === 0) return 'No prior conversation context.';

  return history
    .slice(-6)
    .map(h => {
      const content = normalizeContent(h.content).slice(0, h.role === 'assistant' ? 700 : 300);
      return `${h.role.toUpperCase()}: ${content}`;
    })
    .join('\n');
}

/* ── SSE event types ── */
export type EngineEvent =
  | { type: 'step'; data: AgentStep }
  | { type: 'token'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'done'; response: SearchResponse }
  | { type: 'error'; message: string };

/* ── Extract inline JSON tool call from model text output ── */
interface InlineToolCall {
  raw: string;
  query: string;
  queries?: string[]; // Multiple queries from XML-style tool calls
}

function parseInlineToolCall(content: string): InlineToolCall | null {
  const trimmed = content.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const query = extractQuery(parsed);
    if (query) return { raw: trimmed, query };
  } catch { /* not pure JSON */ }

  const jsonRegex = /\{(?:[^{}]|(?:\{[^{}]*\}))*\}/g;
  let match: RegExpExecArray | null;
  while ((match = jsonRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      const query = extractQuery(parsed);
      if (query) return { raw: match[0], query };
    } catch { continue; }
  }

  // Handle XML-style tool call format produced by some models (e.g. Qwen, Llama):
  // <tool_call><function=web_search><parameter=queries>["q1","q2"]</parameter><parameter=type>search</parameter></function></tool_call>
  const xmlToolCallRegex = /<tool_call>[\s\S]*?<\/tool_call>/g;
  let xmlMatch: RegExpExecArray | null;
  while ((xmlMatch = xmlToolCallRegex.exec(content)) !== null) {
    const block = xmlMatch[0];

    // Extract all <parameter=name>value</parameter> pairs
    const paramRegex = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/g;
    const params: Record<string, any> = {};
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(block)) !== null) {
      const [, key, value] = paramMatch;
      try {
        params[key] = JSON.parse(value.trim());
      } catch {
        params[key] = value.trim();
      }
    }

    const query = extractQuery(params);
    if (query) return { raw: block, query };

    // If queries is an array, return all entries (first is canonical query)
    if (Array.isArray(params.queries) && params.queries.length > 0) {
      const validQueries = params.queries.filter((q: any) => typeof q === 'string' && q.trim());
      if (validQueries.length > 0) {
        return { raw: block, query: validQueries[0], queries: validQueries };
      }
    }
  }

  return null;
}

function extractQuery(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const params = obj.parameters || obj;
  return params.search_query || params.query || params.searchquery || params.q || null;
}

/* ── Shared: run one round of native tool-calling / search ── */
async function toolCallingRound(
  messages: any[],
  allSources: Map<string, SourceWithIndex>,
  steps: AgentStep[],
  round: number,
  onEvent: (ev: EngineEvent) => void,
  budget: ResearchBudgetState,
  onProgress?: (state: ResearchBudgetState) => void,
  signal?: AbortSignal,
  role?: LLMRole,
): Promise<boolean> {
  if (signal?.aborted || budget.remainingCredits <= 0) {
    budget.exhausted = budget.remainingCredits <= 0;
    onProgress?.(budget);
    return false;
  }
  const stepType = round === 0 ? 'plan-analyze' : 'analyze';
  const step: AgentStep = { type: stepType, note: round === 0 ? 'Analyzing question...' : 'Thinking...', context: JSON.stringify(messages, null, 2) };
  steps.push(step);
  onEvent({ type: 'step', data: step });

  const temp = temperatureForRound(round);
  const { data, model, provider } = await callLLM({
    messages,
    temperature: temp,
    tools: [SEARCH_TOOL, FETCH_URL_TOOL],
    toolChoice: 'auto',
    role,
    signal,
    onModelSelected: (selectedModel) => {
      step.model = selectedModel;
      onEvent({ type: 'step', data: step });
    },
    label: `tool-round-${round}`,
  });

  const choice = data!.choices[0];
  const msg = choice.message;
  const finish = choice.finish_reason;

  const currentModel = model;
  const reasoningText = msg.reasoning?.trim();

  step.model = currentModel;
  if (reasoningText) {
    step.note = reasoningText;
  }
  onEvent({ type: 'step', data: step });

  if (finish === 'tool_calls' && msg.tool_calls) {
    const cleanMsg = { role: msg.role, content: msg.content, tool_calls: msg.tool_calls };
    messages.push(cleanMsg);

    // Collect all individual search and fetch tasks
    const searchTasks: { tcId: string; query: string; type: string; stepIndex: number }[] = [];
    const fetchTasks: { tcId: string; url: string; stepIndex: number }[] = [];
    for (const tc of msg.tool_calls) {
      let args: any;
      try { args = JSON.parse(tc.function.arguments); } catch { continue; }
      const tcId = tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      if (tc.function.name === 'fetch_url') {
        const url = (args.url || '').trim();
        if (url) {
          const step: AgentStep = { type: 'webpage', query: url, model: currentModel };
          const stepIndex = steps.length;
          steps.push(step);
          onEvent({ type: 'step', data: step });
          fetchTasks.push({ tcId, url, stepIndex });
        }
        continue;
      }

      // web_search
      const qs = args.queries || args.search_query || args.query || args.searchquery || args.q;
      const searchType = args.type || 'search';

      if (Array.isArray(qs)) {
        for (const q of qs) {
          if (typeof q === 'string' && q.trim()) {
            const step: AgentStep = { type: searchType === 'search' ? 'search' : searchType, query: q.trim(), model: currentModel };
            const stepIndex = steps.length;
            steps.push(step);
            onEvent({ type: 'step', data: step });
            searchTasks.push({ tcId, query: q.trim(), type: searchType, stepIndex });
          }
        }
      } else if (typeof qs === 'string' && qs.trim()) {
        const step: AgentStep = { type: searchType === 'search' ? 'search' : searchType, query: qs.trim(), model: currentModel };
        const stepIndex = steps.length;
        steps.push(step);
        onEvent({ type: 'step', data: step });
        searchTasks.push({ tcId, query: qs.trim(), type: searchType, stepIndex });
      }
    }

    const totalTasks = searchTasks.length + fetchTasks.length;
    if (totalTasks === 0) {
      console.log('[tool_calls] no valid tasks found');
      return false;
    }

    if (budget.remainingCredits <= 0) {
      budget.exhausted = true;
      onProgress?.(budget);
      const step: AgentStep = { type: 'budget', note: 'Research budget exhausted before executing tasks.' };
      steps.push(step);
      onEvent({ type: 'step', data: step });
      return false;
    }

    const allowedSearchTasks = searchTasks.slice(0, budget.remainingCredits);
    const allowedFetchTasks = fetchTasks.slice(0, Math.max(0, budget.remainingCredits - allowedSearchTasks.length));
    const allowedCount = allowedSearchTasks.length + allowedFetchTasks.length;

    if (allowedCount < totalTasks) {
      const step: AgentStep = {
        type: 'budget',
        note: `Research budget limited this round to ${allowedCount} of ${totalTasks} requested tasks.`,
      };
      steps.push(step);
      onEvent({ type: 'step', data: step });
      budget.exhausted = true;
    }

    const searchTimestamps = allowedSearchTasks.map(() => performance.now());
    const fetchTimestamps = allowedFetchTasks.map(() => performance.now());
    const resultsByTcId = new Map<string, any[]>();
    const searchPromises = allowedSearchTasks.map((s, i) =>
      fetchResults(s.query, s.type, signal, role === 'instant' ? 5 : undefined).then(({ results }) => {
        const step = steps[s.stepIndex];
        step.duration_ms = Math.round(performance.now() - searchTimestamps[i]);
        step.result_count = results.length;
        onEvent({ type: 'step', data: step });

        for (const r of results) {
          if (!allSources.has(r.url)) {
            allSources.set(r.url, {
              title: r.title,
              url: r.url,
              domain: domain(r.url),
              snippet: r.snippet,
              source_index: allSources.size + 1,
            });
          }
        }

        if (!resultsByTcId.has(s.tcId)) {
          resultsByTcId.set(s.tcId, []);
        }
        resultsByTcId.get(s.tcId)!.push(
          ...results.map(r => {
            const idx = allSources.get(r.url)?.source_index ?? 0;
            return { ...r, source_index: idx };
          })
        );

        const currentSources = Array.from(allSources.values()).map(({ source_index, ...s }) => s as Source);
        onEvent({ type: 'sources', sources: currentSources });
      })
    );

    const fetchPromises = allowedFetchTasks.map((f, i) =>
      fetchPageContent(f.url, signal).then(({ title, content, error }) => {
        const step = steps[f.stepIndex];
        step.duration_ms = Math.round(performance.now() - fetchTimestamps[i]);

        if (error) {
          // Page was inaccessible — inform the agent but don't abort the whole round
          step.note = `Could not read page (${error})`;
          onEvent({ type: 'step', data: step });
          if (!resultsByTcId.has(f.tcId)) {
            resultsByTcId.set(f.tcId, []);
          }
          resultsByTcId.get(f.tcId)!.push({
            id: 0,
            title: f.url,
            url: f.url,
            source_index: 0,
            snippet: `This page could not be fetched: ${error}`,
            date: null,
          });
          return;
        }

        step.note = title || '';
        onEvent({ type: 'step', data: step });

        if (!allSources.has(f.url)) {
          allSources.set(f.url, {
            title: title || f.url,
            url: f.url,
            domain: domain(f.url),
            snippet: content.slice(0, 500),
            source_index: allSources.size + 1,
          });
        }

        const idx = allSources.get(f.url)?.source_index ?? 0;
        if (!resultsByTcId.has(f.tcId)) {
          resultsByTcId.set(f.tcId, []);
        }
        resultsByTcId.get(f.tcId)!.push({
          id: idx,
          title: title || f.url,
          url: f.url,
          source_index: idx,
          snippet: content.slice(0, 3000),
          date: null,
        });

        const currentSources = Array.from(allSources.values()).map(({ source_index, ...s }) => s as Source);
        onEvent({ type: 'sources', sources: currentSources });
      })
    );

    await Promise.all([...searchPromises, ...fetchPromises]);

    for (const [tcId, indexedResults] of resultsByTcId.entries()) {
      // Deduplicate by URL within this tool response (multiple queries can return the same URL)
      const seenUrls = new Set<string>();
      const dedupedResults = indexedResults.filter((r: any) => {
        if (seenUrls.has(r.url)) return false;
        seenUrls.add(r.url);
        return true;
      });

      const textList = dedupedResults.map((r: any, index: number) => {
        return `${index + 1}. [Source #${r.source_index}] Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet || 'No content'}`;
      }).join('\n\n');
      
      messages.push({
        role: 'tool',
        tool_call_id: tcId,
        content: textList,
      });
    }

    budget.usedCredits += allowedCount;
    budget.remainingCredits -= allowedCount;
    if (budget.remainingCredits <= 0) {
      budget.exhausted = true;
    }
    onProgress?.(budget);

    return true;
  }

  /* ── Inline tool call: model outputs JSON text instead of structured call ── */
  const content = msg.content || '';
  const inlineCall = parseInlineToolCall(content);
  if (inlineCall) {
    const allQueries = inlineCall.queries?.length
      ? inlineCall.queries
      : [(inlineCall.query || '').trim()].filter(Boolean);

    if (allQueries.length > 0) {
      console.log(`[inline tool] parsed ${allQueries.length} quer${allQueries.length === 1 ? 'y' : 'ies'}:`, allQueries);
      const cleanedContent = content.replace(inlineCall.raw, '').trim();
      const cleanMsg = { role: msg.role, content: cleanedContent || null };
      messages.push(cleanMsg);

      if (budget.remainingCredits <= 0) {
        budget.exhausted = true;
        onProgress?.(budget);
        const step: AgentStep = { type: 'budget', note: 'Research budget exhausted before executing inline search.' };
        steps.push(step);
        onEvent({ type: 'step', data: step });
        return false;
      }

      // Limit to remaining budget
      const allowedQueries = allQueries.slice(0, budget.remainingCredits);
      if (allowedQueries.length < allQueries.length) {
        budget.exhausted = true;
      }

      const tcId = `call_inline_${Date.now()}`;

      // Run all queries in parallel
      const queryTimestamps = allowedQueries.map(() => performance.now());
      const queryStepIndices: number[] = [];
      for (const q of allowedQueries) {
        const qStep: AgentStep = { type: 'search', query: q, model: currentModel };
        queryStepIndices.push(steps.length);
        steps.push(qStep);
        onEvent({ type: 'step', data: qStep });
      }

      const allResults = await Promise.all(
        allowedQueries.map(async (q, i) => {
          const { results } = await fetchResults(q, 'search', signal, role === 'instant' ? 5 : undefined);
          const qStep = steps[queryStepIndices[i]];
          qStep.duration_ms = Math.round(performance.now() - queryTimestamps[i]);
          qStep.result_count = results.length;
          onEvent({ type: 'step', data: qStep });
          return results;
        })
      );

      const combined = allResults.flat();
      for (const r of combined) {
        if (!allSources.has(r.url)) {
          allSources.set(r.url, {
            title: r.title,
            url: r.url,
            domain: domain(r.url),
            snippet: r.snippet,
            source_index: allSources.size + 1,
          });
        }
      }

      // Deduplicate by URL
      const seenUrls = new Set<string>();
      const dedupedResults = combined.filter(r => {
        if (seenUrls.has(r.url)) return false;
        seenUrls.add(r.url);
        return true;
      });

      const textList = dedupedResults.map((r, index) => {
        const idx = allSources.get(r.url)?.source_index ?? 0;
        return `${index + 1}. [Source #${idx}] Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet || 'No content'}`;
      }).join('\n\n');

      messages.push({
        role: 'tool',
        tool_call_id: tcId,
        content: textList,
      });

      budget.usedCredits += allowedQueries.length;
      budget.remainingCredits -= allowedQueries.length;
      if (budget.remainingCredits <= 0) budget.exhausted = true;
      onProgress?.(budget);

      // Send current sources to frontend for real-time citation rendering
      const currentSources = Array.from(allSources.values()).map(({ source_index, ...s }) => s as Source);
      onEvent({ type: 'sources', sources: currentSources });

      return true;
    }
  }

  // No tool calls — accept direct answer
  const cleanMsg = { role: msg.role, content: msg.content };
  messages.push(cleanMsg);
  return false;
}



/* ── Streaming agentic loop ── */
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
  const systemPrompt = (mode === 'deep' ? DEEP_SYSTEM_PROMPT : SYSTEM_PROMPT) + `\n\n**Today's date:** ${today}.`;
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
  ];
  const sanitizedHistory = sanitizeHistory(history, query, mode);
  if (sanitizedHistory.length > 0) {
    for (const h of sanitizedHistory) {
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: 'user', content: query });

  const activeRole = mode === 'quick' ? 'instant' : 'deep';

  /* ── Phase 1: Plan → Search → Analyze (native tool-calling loop) ── */
  let usedTools = false;
  let lastRound = 0;
  for (let round = 0; round < maxRounds; round++) {
    if (options.signal?.aborted || budget.remainingCredits <= 0) break;
    const more = await toolCallingRound(messages, allSources, steps, round, onEvent, budget, options.onProgress, options.signal, activeRole);
    if (more) usedTools = true;
    lastRound = round;
    if (!more) break;
  }

  /* ── Chat mode: no tools used → use model's direct response, skip synthesis ── */
  if (!usedTools && allSources.size === 0) {
    const lastMsg = messages[messages.length - 1];
    // Guard: don't treat a raw XML tool call as a direct answer
    if (lastMsg?.role === 'assistant' && lastMsg.content && !parseInlineToolCall(lastMsg.content)) {
      const elapsed = Math.round(performance.now() - start);
      onEvent({ type: 'done', response: { query, answer: lastMsg.content, sources: [], steps, results_count: 0, elapsed_ms: elapsed } });
      return;
    }
  }



  /* ── Phase 3: Synthesize final answer with streaming ── */
  {
    const synthStart = performance.now();
    const synthStep: AgentStep = { type: 'synthesize', note: mode === 'deep' ? 'Synthesizing comprehensive answer...' : 'Answer generated' };
    steps.push(synthStep);
    onEvent({ type: 'step', data: synthStep });

    // Build synthesis messages list:
    // 1. System Prompt (with SYNTHESIS_PROMPT)
    // 2. Chat history (sanitized, actual conversational messages ONLY; excluding raw tool outputs)
    // 3. Current User Query
    // 4. Current execution loop messages (tool calls & tool responses from the CURRENT loop/turn)
    const currentLoopStartIndex = sanitizedHistory.length + 2; // [system, ...sanitizedHistory, userQuery]
    // Filter out assistant messages that contain raw XML tool calls — these are
    // inline tool calls that were already executed and must not be forwarded to
    // the synthesis model as if they were conversational turns.
    const currentLoopMessages = messages
      .slice(currentLoopStartIndex)
      .filter((m: any) => {
        if (m.role === 'assistant' && m.content && parseInlineToolCall(m.content)) {
          return false; // drop raw XML tool call messages
        }
        return true;
      });

    const activeSystemPrompt = mode === 'deep' ? DEEP_SYSTEM_PROMPT : SYSTEM_PROMPT;
    const synthMessages = [
      { role: 'system', content: `${activeSystemPrompt}\n\n${SYNTHESIS_PROMPT}` },
      ...sanitizedHistory,
      { role: 'user', content: query },
      ...currentLoopMessages,
    ];

    synthStep.context = JSON.stringify(synthMessages, null, 2);

    let fullContent: string;
    try {
      const result = await callLLMStream({
        messages: synthMessages,
        temperature: 0,
        role: activeRole,
        signal: options.signal,
        onToken: (text) => { onEvent({ type: 'token', text }); },
        onModelSelected: (selectedModel) => {
          synthStep.model = selectedModel;
          onEvent({ type: 'step', data: synthStep });
        },
        label: 'synthesis',
      });
      fullContent = result.fullContent || '';
    } catch (err: any) {
      onEvent({ type: 'error', message: err.message || 'Synthesis failed' });
      return;
    }

    // Guard: if the synthesis model produced a raw XML tool call instead of an
    // answer (can happen when the model also emits XML-style tool calls), strip it.
    if (parseInlineToolCall(fullContent)) {
      fullContent = fullContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    }

    if (!fullContent) {
      onEvent({ type: 'error', message: 'Synthesis returned empty response.' });
      return;
    }

    synthStep.duration_ms = Math.round(performance.now() - synthStart);

    const elapsed = Math.round(performance.now() - start);
    if (budget.exhausted) {
      const budgetStep: AgentStep = { type: 'budget', note: `Research budget used ${budget.usedCredits}/${budget.usedCredits + budget.remainingCredits}` };
      steps.push(budgetStep);
      onEvent({ type: 'step', data: budgetStep });
    }
    onEvent({
      type: 'done',
      response: {
        query,
        answer: fullContent,
        sources: Array.from(allSources.values()).map(({ source_index, ...s }) => s as Source),
        steps,
        results_count: allSources.size,
        elapsed_ms: elapsed,
        research_budget: {
          used: budget.usedCredits,
          limit: budget.usedCredits + budget.remainingCredits,
          exhausted: budget.exhausted,
        },
      },
    });
  }
}

