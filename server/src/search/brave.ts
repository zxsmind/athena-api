import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

/** Brave Web Search. Docs: https://api-dashboard.search.brave.com/api-reference/web/search/get */
export const BRAVE_BASE_URL = 'https://api.search.brave.com/res/v1/web/search';

/* Brave freshness values for our time-range vocabulary. */
const FRESHNESS = { day: 'pd', week: 'pw', month: 'pm', year: 'py' } as const;

const ring = createKeyRing(() => loadSettings().searchProviders.brave?.keys ?? []);

async function braveSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  /* Brave accepts at most 20 results per call. */
  const maxSources = Math.min(limit ?? getConfig().search.defaultResultCount, 20);
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.brave?.url ?? BRAVE_BASE_URL).replace(/\/+$/, '');
  const params = new URLSearchParams({ q: query, count: String(maxSources) });
  if (options.country) params.set('country', options.country.toUpperCase());
  if (options.language) params.set('search_lang', options.language);
  if (options.timeRange && FRESHNESS[options.timeRange]) params.set('freshness', FRESHNESS[options.timeRange]);
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(`${base}?${params.toString()}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`Brave API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    const web = (data.web ?? {}) as Record<string, unknown>;
    const items = (web.results ?? []) as unknown[];
    const results: SearchResult[] = items.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      const extra = Array.isArray(it.extra_snippets) ? (it.extra_snippets as string[]).join(' ... ') : '';
      const description = String(it.description || '');
      return {
        id: i + 1,
        title: String(it.title || ''),
        url: String(it.url || ''),
        snippet: (description + (extra ? ` ... ${extra}` : '')).trim() || null,
        date: (it.age || null) as string | null,
      };
    });
    const queryText = ((data.query as Record<string, unknown> | undefined)?.original as string) || query;
    return { results, queryText };
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

export const braveProvider: SearchProvider = {
  id: 'brave',
  isConfigured: () => loadSettings().searchProviders.brave?.keys.some((key) => key.trim().length > 0) ?? false,
  search: braveSearch,
  reset: () => { ring.reset(); },
};
