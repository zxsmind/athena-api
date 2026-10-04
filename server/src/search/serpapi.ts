import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

/** SerpApi (Google engine). Docs: https://serpapi.com/search-api */
export const SERPAPI_BASE_URL = 'https://serpapi.com/search.json';

const ring = createKeyRing(() => loadSettings().searchProviders.serpapi?.keys ?? []);

async function serpapiSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  const maxSources = limit ?? getConfig().search.defaultResultCount;
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.serpapi?.url ?? SERPAPI_BASE_URL).replace(/\/+$/, '');
  const params = new URLSearchParams({
    engine: 'google',
    q: query,
    num: String(maxSources),
    api_key: key,
  });
  if (options.country) params.set('gl', options.country);
  if (options.language) params.set('hl', options.language);
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(`${base}?${params.toString()}`, { signal: timeoutSignal });
    if (!res.ok) throw new Error(`SerpApi error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    const organic = (data.organic_results ?? []) as unknown[];
    const results: SearchResult[] = organic.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      return {
        id: (it.position as number) ?? i + 1,
        title: String(it.title || ''),
        url: String(it.link || ''),
        snippet: (it.snippet || null) as string | null,
        date: (it.date || null) as string | null,
      };
    });
    const queryText = ((data.search_parameters as Record<string, unknown> | undefined)?.q as string) || query;
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

export const serpapiProvider: SearchProvider = {
  id: 'serpapi',
  isConfigured: () => loadSettings().searchProviders.serpapi?.keys.some((key) => key.trim().length > 0) ?? false,
  search: serpapiSearch,
  reset: () => { ring.reset(); },
};
