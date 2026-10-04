import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

/** Linkup Search. Docs: https://docs.linkup.so/pages/documentation/api-reference/endpoint/post-search */
export const LINKUP_BASE_URL = 'https://api.linkup.so/v1/search';

const ring = createKeyRing(() => loadSettings().searchProviders.linkup?.keys ?? []);

async function linkupSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  const maxSources = limit ?? getConfig().search.defaultResultCount;
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.linkup?.url ?? LINKUP_BASE_URL).replace(/\/+$/, '');
  const body: Record<string, unknown> = { q: query, depth: 'default', outputType: 'searchResults', maxResults: maxSources };
  if (options.includeDomains?.length) body.includeDomains = options.includeDomains;
  if (options.excludeDomains?.length) body.excludeDomains = options.excludeDomains;
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`Linkup API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    const items = (data.results ?? []) as unknown[];
    const results: SearchResult[] = items.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      return {
        id: i + 1,
        title: String(it.name || ''),
        url: String(it.url || ''),
        snippet: (it.content || null) as string | null,
        date: null,
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

export const linkupProvider: SearchProvider = {
  id: 'linkup',
  isConfigured: () => loadSettings().searchProviders.linkup?.keys.some((key) => key.trim().length > 0) ?? false,
  search: linkupSearch,
  reset: () => { ring.reset(); },
};
