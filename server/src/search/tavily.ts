import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

/** Tavily Search. Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search */
export const TAVILY_BASE_URL = 'https://api.tavily.com/search';

const TIME_RANGE = { day: 'day', week: 'week', month: 'month', year: 'year' } as const;

const ring = createKeyRing(() => loadSettings().searchProviders.tavily?.keys ?? []);

async function tavilySearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  /* Tavily accepts at most 20 results per call. */
  const maxSources = Math.min(limit ?? getConfig().search.defaultResultCount, 20);
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.tavily?.url ?? TAVILY_BASE_URL).replace(/\/+$/, '');
  const body: Record<string, unknown> = { query, search_depth: 'basic', max_results: maxSources };
  if (options.timeRange && TIME_RANGE[options.timeRange]) body.time_range = TIME_RANGE[options.timeRange];
  if (options.includeDomains?.length) body.include_domains = options.includeDomains;
  if (options.excludeDomains?.length) body.exclude_domains = options.excludeDomains;
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    const items = (data.results ?? []) as unknown[];
    const results: SearchResult[] = items.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      return {
        id: i + 1,
        title: String(it.title || ''),
        url: String(it.url || ''),
        snippet: (it.content || null) as string | null,
        date: (it.published_date || null) as string | null,
      };
    });
    return { results, queryText: (data.query as string) || query };
  } catch (err: unknown) {
    if (signal?.aborted) throw err;
    const message = (err as Error).name === 'AbortError'
      ? `Search timed out after ${getConfig().search.requestTimeoutMs / 1000}s`
      : (err as Error).message || 'Search failed';
    throw new Error(message);
  } finally {
    clean();
  }
}

export const tavilyProvider: SearchProvider = {
  id: 'tavily',
  isConfigured: () => loadSettings().searchProviders.tavily?.keys.some((key) => key.trim().length > 0) ?? false,
  search: tavilySearch,
  reset: () => { ring.reset(); },
};
