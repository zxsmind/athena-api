import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

/**
 * FreeSerp keyless web search. Docs: https://freeserp.ai/
 *
 * No API key, no signup: a single GET returns JSON over FreeSerp's own
 * index. Opt-in is explicit — the settings entry must carry `keyless: true`,
 * mirroring `ProviderState.anonymous` on the LLM side.
 */
export const FREESERP_BASE_URL = 'https://freeserp.ai/api.php';

function isEnabled(): boolean {
  return loadSettings().searchProviders.freeserp?.keyless === true;
}

async function freeserpSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  if (!isEnabled()) throw new SearchProviderNotConfiguredError();
  /* FreeSerp Global returns ranked candidates; keep the page small. */
  const maxSources = Math.min(Math.max(limit ?? getConfig().search.defaultResultCount, 1), 50);

  const base = (loadSettings().searchProviders.freeserp?.url ?? FREESERP_BASE_URL).replace(/\/+$/, '');
  const params = new URLSearchParams({ q: query, index: 'web', num: String(maxSources) });
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(`${base}?${params}`, { signal: timeoutSignal });
    if (!res.ok) throw new Error(`FreeSerp API error: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (data.ok !== true && data.ok !== undefined && data.ok !== 1) {
      throw new Error(`FreeSerp API error: ${JSON.stringify(data).slice(0, 200)}`);
    }
    const items = (data.results ?? []) as unknown[];
    const results: SearchResult[] = items.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      return {
        id: i + 1,
        title: String(it.title || ''),
        url: String(it.url || ''),
        snippet: (it.snippet as string | null) ?? null,
        date: (it.published_at as string | null) ?? null,
      };
    });
    void options;
    return { results, queryText: typeof data.query === 'string' ? data.query : query };
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

export const freeserpProvider: SearchProvider = {
  id: 'freeserp',
  isConfigured: () => isEnabled(),
  search: freeserpSearch,
};
