import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider } from './types.js';

/**
 * Jina Reader as a search (SERP) API. The reader endpoint searches the web and
 * returns the top entries with content; JSON is requested explicitly.
 * Without a key the endpoint still answers at a low rate limit, but Athena
 * treats a missing key as not configured so usage stays accountable.
 */
export const JINA_BASE_URL = 'https://s.jina.ai/';

const ring = createKeyRing(() => loadSettings().searchProviders.jina?.keys ?? []);

async function jinaSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
): Promise<SearchOutcome> {
  const maxSources = limit ?? getConfig().search.defaultResultCount;
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.jina?.url ?? JINA_BASE_URL).replace(/\/+$/, '');
  const params = new URLSearchParams({ q: query });
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(`${base}/?${params.toString()}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`Jina API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    const items = Array.isArray(data) ? data : ((data.data ?? []) as unknown[]);
    const results: SearchResult[] = (items as unknown[]).slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      return {
        id: i + 1,
        title: String(it.title || ''),
        url: String(it.url || ''),
        snippet: ((it.content ?? it.description ?? null) as string | null),
        date: ((it.publishedDate ?? it.date ?? it.timestamp ?? null) as string | null),
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

export const jinaProvider: SearchProvider = {
  id: 'jina',
  isConfigured: () => loadSettings().searchProviders.jina?.keys.some((key) => key.trim().length > 0) ?? false,
  search: jinaSearch,
  reset: () => { ring.reset(); },
};
