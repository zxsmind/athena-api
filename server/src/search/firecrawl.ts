import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

/** Firecrawl Search (v2). Docs: https://docs.firecrawl.dev/api-reference/endpoint/search */
export const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v2/search';

const ring = createKeyRing(() => loadSettings().searchProviders.firecrawl?.keys ?? []);

async function firecrawlSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  const maxSources = limit ?? getConfig().search.defaultResultCount;
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.firecrawl?.url ?? FIRECRAWL_BASE_URL).replace(/\/+$/, '');
  const body: Record<string, unknown> = { query, limit: maxSources };
  if (options.includeDomains?.length && options.excludeDomains?.length) {
    /* The API treats the two as mutually exclusive; prefer exclusion. */
    body.excludeDomains = options.excludeDomains;
  } else if (options.includeDomains?.length) {
    body.includeDomains = options.includeDomains;
  } else if (options.excludeDomains?.length) {
    body.excludeDomains = options.excludeDomains;
  }
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`Firecrawl API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    if (data.success === false) throw new Error(`Firecrawl API error: ${String((data as Record<string, unknown>).error || 'request failed')}`);
    const payload = (data.data ?? {}) as Record<string, unknown>;
    const items = (payload.web ?? []) as unknown[];
    const results: SearchResult[] = items.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      return {
        id: (it.position as number) ?? i + 1,
        title: String(it.title || ''),
        url: String(it.url || ''),
        snippet: (it.description || null) as string | null,
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

export const firecrawlProvider: SearchProvider = {
  id: 'firecrawl',
  isConfigured: () => loadSettings().searchProviders.firecrawl?.keys.some((key) => key.trim().length > 0) ?? false,
  search: firecrawlSearch,
  reset: () => { ring.reset(); },
};
