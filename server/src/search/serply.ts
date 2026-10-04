import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider } from './types.js';

/** Serply Google Search. Docs: https://serply.io/docs/resources/google-search */
export const SERPLY_BASE_URL = 'https://api.serply.io/v1/search';

const ring = createKeyRing(() => loadSettings().searchProviders.serply?.keys ?? []);

async function serplySearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
): Promise<SearchOutcome> {
  const maxSources = limit ?? getConfig().search.defaultResultCount;
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.serply?.url ?? SERPLY_BASE_URL).replace(/\/+$/, '');
  const params = new URLSearchParams({ q: query, num: String(maxSources) });
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(`${base}?${params.toString()}`, {
      headers: { 'X-Api-Key': key },
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`Serply API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    const items = (data.results ?? []) as unknown[];
    const results: SearchResult[] = items.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      return {
        id: (it.position as number) ?? i + 1,
        title: String(it.title || ''),
        url: String(it.link || ''),
        snippet: (it.description || null) as string | null,
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

export const serplyProvider: SearchProvider = {
  id: 'serply',
  isConfigured: () => loadSettings().searchProviders.serply?.keys.some((key) => key.trim().length > 0) ?? false,
  search: serplySearch,
  reset: () => { ring.reset(); },
};
