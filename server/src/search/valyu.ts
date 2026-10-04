import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider } from './types.js';

/**
 * Valyu Search. Docs: https://docs.valyu.ai/api-reference/endpoint/search
 *
 * Authentication is `x-api-key`, explicitly not a Bearer token.
 * `search_type: 'web'` keeps results to web sources; the default `all` would
 * mix in proprietary datasets the caller did not ask for.
 */
export const VALYU_BASE_URL = 'https://api.valyu.ai/v1/search';

const ring = createKeyRing(() => loadSettings().searchProviders.valyu?.keys ?? []);

async function valyuSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
): Promise<SearchOutcome> {
  /* Valyu accepts 1–20 results per call. */
  const maxSources = Math.min(Math.max(limit ?? getConfig().search.defaultResultCount, 1), 20);
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.valyu?.url ?? VALYU_BASE_URL).replace(/\/+$/, '');
  const body: Record<string, unknown> = { query, search_type: 'web', max_num_results: maxSources };
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`Valyu API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    if (data.success === false) throw new Error(`Valyu API error: ${String(data.error || 'request failed')}`);
    const items = (data.results ?? []) as unknown[];
    const results: SearchResult[] = items.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      return {
        id: i + 1,
        title: String(it.title || ''),
        url: String(it.url || ''),
        snippet: (it.content || null) as string | null,
        date: null,
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

export const valyuProvider: SearchProvider = {
  id: 'valyu',
  isConfigured: () => loadSettings().searchProviders.valyu?.keys.some((key) => key.trim().length > 0) ?? false,
  search: valyuSearch,
  reset: () => { ring.reset(); },
};
