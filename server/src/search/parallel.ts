import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider } from './types.js';

/** Parallel Search (v1). Docs: https://docs.parallel.ai/api-reference/search/search */
export const PARALLEL_BASE_URL = 'https://api.parallel.ai/v1/search';

const ring = createKeyRing(() => loadSettings().searchProviders.parallel?.keys ?? []);

async function parallelSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
): Promise<SearchOutcome> {
  const maxSources = limit ?? getConfig().search.defaultResultCount;
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.parallel?.url ?? PARALLEL_BASE_URL).replace(/\/+$/, '');
  /* Both fields are sent: older revisions require one of them, newer ones the queries. */
  const body: Record<string, unknown> = { objective: query, search_queries: [query], max_results: maxSources };
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`Parallel API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    const items = (data.results ?? []) as unknown[];
    const results: SearchResult[] = items.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      const excerpts = Array.isArray(it.excerpts) ? (it.excerpts as string[]).join('\n\n') : '';
      return {
        id: i + 1,
        title: String(it.title || ''),
        url: String(it.url || ''),
        snippet: excerpts.trim() || null,
        date: (it.publish_date || null) as string | null,
      };
    });
    return { results, queryText: query };
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

export const parallelProvider: SearchProvider = {
  id: 'parallel',
  isConfigured: () => loadSettings().searchProviders.parallel?.keys.some((key) => key.trim().length > 0) ?? false,
  search: parallelSearch,
  reset: () => { ring.reset(); },
};
