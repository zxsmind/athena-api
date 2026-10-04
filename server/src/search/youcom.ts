import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

/** You.com Web Search. Docs: https://you.com/docs/api-reference/search/v1-search */
export const YOUCOM_BASE_URL = 'https://ydc-index.io/v1/search';

const ring = createKeyRing(() => loadSettings().searchProviders.youcom?.keys ?? []);

async function youcomSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  const maxSources = limit ?? getConfig().search.defaultResultCount;
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.youcom?.url ?? YOUCOM_BASE_URL).replace(/\/+$/, '');
  const body: Record<string, unknown> = { query, count: maxSources };
  if (options.includeDomains?.length) body.include_domains = options.includeDomains;
  if (options.excludeDomains?.length) body.exclude_domains = options.excludeDomains;
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`You.com API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    const web = ((data.results as Record<string, unknown> | undefined)?.web ?? []) as unknown[];
    const results: SearchResult[] = web.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      const snippets = Array.isArray(it.snippets) ? (it.snippets as string[]).join(' ... ') : '';
      return {
        id: i + 1,
        title: String(it.title || ''),
        url: String(it.url || ''),
        snippet: (String(it.description || '') + (snippets ? ` ... ${snippets}` : '')).trim() || null,
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

export const youcomProvider: SearchProvider = {
  id: 'youcom',
  isConfigured: () => loadSettings().searchProviders.youcom?.keys.some((key) => key.trim().length > 0) ?? false,
  search: youcomSearch,
  reset: () => { ring.reset(); },
};
