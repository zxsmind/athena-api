import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

/** Exa Search. Docs: https://exa.ai/docs/reference/search-api-guide-for-coding-agents */
export const EXA_BASE_URL = 'https://api.exa.ai/search';

const ring = createKeyRing(() => loadSettings().searchProviders.exa?.keys ?? []);

async function exaSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  /* Exa accepts 1–100 results per call. */
  const maxSources = Math.min(Math.max(limit ?? getConfig().search.defaultResultCount, 1), 100);
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.exa?.url ?? EXA_BASE_URL).replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    query,
    numResults: maxSources,
    /* Highlights keep snippets token-efficient; without contents there is no snippet at all. */
    contents: { highlights: true },
  };
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
    if (!res.ok) throw new Error(`Exa API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    const items = (data.results ?? []) as unknown[];
    const results: SearchResult[] = items.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      const highlights = Array.isArray(it.highlights) ? (it.highlights as string[]).join(' ... ') : '';
      return {
        id: i + 1,
        title: String(it.title || ''),
        url: String(it.url || ''),
        snippet: highlights.trim() || (it.text as string | null) || null,
        date: (it.publishedDate || null) as string | null,
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

export const exaProvider: SearchProvider = {
  id: 'exa',
  isConfigured: () => loadSettings().searchProviders.exa?.keys.some((key) => key.trim().length > 0) ?? false,
  search: exaSearch,
  reset: () => { ring.reset(); },
};
