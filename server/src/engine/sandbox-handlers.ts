/**
 * Engine side of a sandbox program's `search`, `extract` and `read_source`
 * calls. Shared by the code engine only: the classic engine never runs a
 * sandbox. Each call charges the same meter as the equivalent classic tool and
 * numbers sources in the same registry, so a citation written from the sandbox
 * resolves through `sanitizeResearchAnswer` exactly like one written from
 * `web_search`.
 */
import { extractPageContent, searchResults } from '../search/index.js';
import { getConfig } from '../config/load.js';
import { traceEvent } from '../trace.js';
import { withRetry } from './retry.js';
import { storeEvidence, recallSource } from './evidence-store.js';
import { recordLedgerFetch, recordLedgerSearch } from './research-ledger.js';
import { planForModel, planSummary, validatePlanEditItems, type PlanReadArgs, type ResearchPlan } from './plan-tools.js';
import { selectExcerpts } from './excerpts.js';
import { domain } from './history.js';
import { budgetReadingObject } from './modes.js';
import {
  chargeFetchCalls,
  chargeSearchCalls,
  remainingFetchCalls,
  remainingSearchCalls,
  type BudgetState,
  type ResearchPreset,
} from './modes.js';
import type { DeepResearchState } from './context-blocks.js';
import type { SourceWithIndex } from './types.js';
import type { SandboxHandlers } from '../sandbox/types.js';

export interface SandboxHandlerContext {
  allSources: Map<string, SourceWithIndex>;
  budget: BudgetState;
  preset: ResearchPreset;
  round: number;
  deepState?: DeepResearchState;
  traceId?: string;
  signal?: AbortSignal;
  publishSources: () => void;
  /** The job's plan, owned by the code loop. Engine-verified like the
    classic one: recon-first creation, evidence-backed dones. */
  planRef?: { current: ResearchPlan | null };
  /** Set by decline(); the engine ends the run after the program returns. */
  declinedRef?: { reason: string | null };
}

/** Snippet characters kept per search hit: enough to judge relevance, small
 *  enough that a batched search does not eat the round. Detail travels
 *  through targeted extract, not through longer snippets. */
export const SANDBOX_SEARCH_SNIPPET_CHARS = 200;

/** Pages one extract call may carry, mirroring the classic fetch batch. */
export const SANDBOX_MAX_URLS_PER_EXTRACT = 4;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Running counters attached to every RPC answer, so the program sizes its
 *  next batch from what is left. Separate injected manifests were measured
 *  harmful; numbers riding results the model already reads are not. */
function usageLine(ctx: SandboxHandlerContext): {
  used_search_calls: number;
  search_calls_limit: number;
  used_fetch_calls: number;
  fetch_calls_limit: number;
} {
  return {
    used_search_calls: ctx.budget.usedSearchCalls,
    search_calls_limit: ctx.preset.maxSearchCalls,
    used_fetch_calls: ctx.budget.usedFetchCalls,
    fetch_calls_limit: ctx.preset.maxFetchCalls,
  };
}

export function createSandboxHandlers(ctx: SandboxHandlerContext): SandboxHandlers {
  const retryDelays = getConfig().research.retryDelaysMs;
  const claimSearch = (): string | null => {
    if (remainingSearchCalls(ctx.budget, ctx.preset) <= 0) return 'Search ceiling reached for this job.';
    chargeSearchCalls(ctx.budget, 1);
    return null;
  };
  /* Warn while searches still run: the model decides per program, so the
     signal must ride the RPC result it actually reads — not a prompt line it
     may skim and not a ceiling that arrives too late. Fires once per
     crossing: repeated warnings would train the model to ignore them. */
  const searchWarningThreshold = Math.max(4, Math.ceil(ctx.preset.maxSearchCalls / 4));
  let searchWarned = false;
  const searchWarning = (): string | null => {
    if (searchWarned || remainingSearchCalls(ctx.budget, ctx.preset) > searchWarningThreshold) return null;
    searchWarned = true;
    const used = ctx.budget.usedSearchCalls;
    if (ctx.traceId) {
      traceEvent(ctx.traceId, 'note', { search_warning: true, used_search_calls: used, search_calls_limit: ctx.preset.maxSearchCalls }, ctx.round);
    }
    return `Search allowance nearly spent (${used}/${ctx.preset.maxSearchCalls} used). Prefer extracting and answering from what you have; further searches may not run.`;
  };
  const claimFetch = (): string | null => {
    if (remainingFetchCalls(ctx.budget, ctx.preset) <= 0) return 'Page-read ceiling reached for this job.';
    chargeFetchCalls(ctx.budget, 1);
    return null;
  };
  const indexOf = (url: string): number => ctx.allSources.get(url)?.source_index ?? 0;
  return {
    async search(args) {
      const raw = args.queries ?? args.query;
      const allQueries = (Array.isArray(raw) ? raw : [raw]).map(value => String(value).trim()).filter(Boolean);
      /* One program cannot spend more than one classic call: parity with
         maxQueriesPerSearchCall keeps a single batch from eating the ceiling. */
      const maxQueries = getConfig().research.maxQueriesPerSearchCall;
      const queries = allQueries.slice(0, maxQueries);
      const dropped = allQueries.length - queries.length;
      const type = typeof args.type === 'string' ? args.type : 'search';
      const results: unknown[] = [];
      let denial: string | null = null;
      for (const query of queries) {
        denial = claimSearch();
        if (denial) break;
        const started = performance.now();
        const outcome = await withRetry('web_search', retryDelays, () => searchResults(query, type, ctx.signal), { signal: ctx.signal });
        const found = outcome.ok ? (outcome.value?.results ?? []) : [];
        if (ctx.traceId) {
          traceEvent(ctx.traceId, 'code.rpc', {
            fn: 'search', query, type, results: found.length,
            error: outcome.ok ? null : outcome.error, ms: Math.round(performance.now() - started),
          }, ctx.round);
        }
        if (!outcome.ok) return { results, error: `Search failed: ${outcome.error}` };
        if (ctx.deepState) recordLedgerSearch(ctx.deepState.ledger, query, ctx.round, found.length, found.map(r => r.url));
        for (const result of found) {
          if (!ctx.allSources.has(result.url)) {
            ctx.allSources.set(result.url, { title: result.title, url: result.url, domain: domain(result.url), snippet: result.snippet, source_index: ctx.allSources.size + 1 });
          }
          if (ctx.traceId) {
            storeEvidence(ctx.traceId, {
              sourceIndex: indexOf(result.url), url: result.url, title: result.title,
              kind: 'search_result', fetched: false, text: result.snippet || '', round: ctx.round,
            });
          }
          results.push({ n: indexOf(result.url), title: result.title, url: result.url, snippet: (result.snippet ?? '').slice(0, SANDBOX_SEARCH_SNIPPET_CHARS) });
        }
      }
      ctx.publishSources();
      const warning = denial ? null : searchWarning();
      return {
        results,
        ...(denial ? { error: denial } : {}),
        ...(dropped > 0 ? { dropped } : {}),
        ...(warning ? { warning } : {}),
        usage: usageLine(ctx),
      };
    },
    async extract(args) {
      const raw = args.urls ?? args.url;
      const allUrls = (Array.isArray(raw) ? raw : [raw]).map(value => String(value ?? '').trim()).filter(Boolean);
      if (allUrls.length === 0) return { error: 'extract needs urls.' };
      const urls = allUrls.slice(0, SANDBOX_MAX_URLS_PER_EXTRACT);
      const dropped = allUrls.length - urls.length;
      /* Targeted reader: with a question the engine returns the passages that
         answer it instead of the page head. Without one it clips the head, as
         before. max_chars bounds one page, not the batch. */
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      const maxChars = clampInt(args.max_chars ?? args.maxChars, 500, 20_000, getConfig().search.extractionContextChars);
      const pages: unknown[] = [];
      for (const url of urls) {
        const denial = claimFetch();
        if (denial) {
          pages.push({ url, error: denial });
          continue;
        }
        const started = performance.now();
        const outcome = await withRetry('fetch_url', retryDelays, () => extractPageContent(url, ctx.signal), { signal: ctx.signal });
        const content = outcome.ok ? (outcome.value?.content ?? '') : '';
        if (ctx.traceId) {
          traceEvent(ctx.traceId, 'code.rpc', {
            fn: 'extract', url, question: question || null, max_chars: maxChars,
            chars: content.length,
            error: outcome.ok ? (outcome.value?.error ?? null) : outcome.error,
            ms: Math.round(performance.now() - started),
          }, ctx.round);
        }
        if (!outcome.ok) {
          pages.push({ url, error: `Could not read page: ${outcome.error}` });
          continue;
        }
        const page = outcome.value!;
        if (page.error) {
          pages.push({ url, error: `Could not read page: ${page.error}` });
          continue;
        }
        if (ctx.deepState) recordLedgerFetch(ctx.deepState.ledger, url, ctx.round, true, page.title || url);
        if (!ctx.allSources.has(url)) {
          ctx.allSources.set(url, {
            title: page.title || url, url, domain: domain(url),
            snippet: content.slice(0, getConfig().search.extractionSnippetChars),
            source_index: ctx.allSources.size + 1,
          });
        }
        if (ctx.traceId) {
          storeEvidence(ctx.traceId, {
            sourceIndex: indexOf(url), url, title: page.title || url,
            kind: 'page', fetched: true, text: content, round: ctx.round,
          });
        }
        const selection = question
          ? selectExcerpts(content, question, maxChars)
          : { excerpts: content.trim().length > 0 ? [{ text: content.slice(0, maxChars) }] : [], coveredChars: 0 };
        pages.push({
          n: indexOf(url), title: page.title || url, url,
          chars: content.length,
          excerpts: selection.excerpts,
        });
      }
      ctx.publishSources();
      return {
        pages,
        ...(dropped > 0 ? { dropped } : {}),
        usage: usageLine(ctx),
      };
    },
    async plan(args) {
      if (!ctx.planRef) return { error: 'plan is not available on this run.' };
      if (ctx.budget.usedSearchCalls + ctx.budget.usedFetchCalls === 0) {
        return { error: 'Plan rejected: run at least one search or extract first, then create the plan from what the results showed.' };
      }
      const items = Array.isArray(args.items) ? args.items : [];
      const goal = typeof args.goal === 'string' ? args.goal : '';
      ctx.planRef.current = {
        goal,
        items: items
          .filter((item): item is { text: unknown } => !!item && typeof item === 'object')
          .map((item) => ({ text: String((item as { text?: unknown }).text ?? ''), status: 'pending' as const })),
      };
      if (ctx.traceId) {
        traceEvent(ctx.traceId, 'code.rpc', { fn: 'plan', goal, items: ctx.planRef.current.items.length }, ctx.round);
      }
      return { ok: true, summary: planSummary(ctx.planRef.current) };
    },
    async plan_update(args) {
      const plan = ctx.planRef?.current;
      if (!plan) return { error: 'No plan yet: create one with plan() first.' };
      const items = (Array.isArray(args.items) ? args.items : []) as { text: unknown; status: unknown; evidence?: unknown }[];
      const knownSources = new Set(Array.from(ctx.allSources.values()).map((s) => s.source_index));
      const problems = validatePlanEditItems(items, knownSources);
      if (problems.length > 0) {
        if (ctx.traceId) {
          traceEvent(ctx.traceId, 'code.rpc', { fn: 'plan_update', rejected: problems.length }, ctx.round);
        }
        return { ok: false, error: `Plan edit rejected:\n- ${problems.join('\n- ')}` };
      }
      if (typeof args.goal === 'string') plan.goal = args.goal;
      plan.items = items.map((i) => ({
        text: String(i.text ?? ''),
        status: (['pending', 'done', 'failed'].includes(i.status as string) ? i.status : 'pending') as 'pending' | 'done' | 'failed',
        evidence: Array.isArray(i.evidence) ? (i.evidence as unknown[]).filter((n): n is number => typeof n === 'number') : undefined,
      }));
      if (ctx.traceId) {
        traceEvent(ctx.traceId, 'code.rpc', { fn: 'plan_update', summary: planSummary(plan) }, ctx.round);
      }
      return { ok: true, summary: planSummary(plan) };
    },
    async plan_read(args) {
      const view = planForModel(ctx.planRef?.current ?? null, args as PlanReadArgs);
      return { content: view.content, truncated: view.truncated, next_offset: view.nextOffset };
    },
    async budget() {
      return { ok: true, budget: budgetReadingObject(ctx.budget, ctx.preset) };
    },
    async decline(args) {
      const rawReason = args.reason;
      const reason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : 'No reason given.';
      if (ctx.declinedRef) ctx.declinedRef.reason = reason;
      if (ctx.traceId) {
        traceEvent(ctx.traceId, 'code.rpc', { fn: 'decline', reason }, ctx.round);
      }
      return { ok: true, note: 'Request declined. The run ends after this program.' };
    },
    async read_source(args) {
      if (!ctx.traceId) return { error: 'read_source is only available on a stored research job.' };
      const source = Number(args.n ?? args.source);
      const view = recallSource(ctx.traceId, {
        source: Number.isFinite(source) ? source : -1,
        ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      });
      if (ctx.traceId) {
        traceEvent(ctx.traceId, 'code.rpc', {
          fn: 'read_source', source: Number.isFinite(source) ? source : null,
          returned_chars: view.content.length, truncated: view.truncated,
        }, ctx.round);
      }
      return { n: source, content: view.content, next_offset: view.nextOffset };
    },
  };
}
