import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

export const SERPER_BASE_URL = 'https://google.serper.dev/search';

const ring = createKeyRing(() => loadSettings().searchProviders.serper?.keys ?? []);

function endpoint(type: string): string {
  const base = (loadSettings().searchProviders.serper?.url ?? getConfig().search.baseUrl).replace(/\/+$/, '');
  return type === 'search' ? base : `${base}/${type}`;
}

function queryWithTimeRange(query: string, timeRange?: WebSearchOptions['timeRange']): string {
  if (!timeRange) return query;
  const days = { day: 1, week: 7, month: 30, year: 365 }[timeRange];
  const after = new Date();
  after.setUTCDate(after.getUTCDate() - days);
  return `${query} after:${after.toISOString().slice(0, 10)}`;
}

function extractOrganic(data: unknown): unknown[] {
  const d = data as Record<string, unknown>;
  if (d.organic) return d.organic as unknown[];
  if (d.results) return d.results as unknown[];
  if (d.articles) return d.articles as unknown[];
  if (d.items) return d.items as unknown[];
  if (Array.isArray(data)) return data;
  return [];
}

async function serperSearch(
  query: string,
  type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  const maxSources = limit ?? getConfig().search.defaultResultCount;
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const queryForProvider = queryWithTimeRange(query, options.timeRange);
  const body: Record<string, unknown> = {
    q: queryForProvider,
    gl: options.country || 'us',
    hl: options.language || 'en',
    num: maxSources,
  };
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(endpoint(type), {
      method: 'POST',
      headers: {
        'X-API-KEY': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });

    if (!res.ok) {
      throw new Error(`Serper API error (${type}): ${res.status} ${res.statusText}`);
    }

    const data: unknown = await res.json();

    const organic = extractOrganic(data);
    const results: SearchResult[] = organic
      .slice(0, maxSources)
      .map((item: unknown, i: number) => { const it = item as Record<string, unknown>; return ({
        id: (it.position as number) ?? i + 1,
        title: String(it.title || ''),
        url: String(it.link || it.url || ''),
        snippet: (it.snippet || it.description || null) as string | null,
        date: (it.date || null) as string | null,
      }); });

    const queryText = ((data as Record<string, unknown>)?.searchParameters as Record<string, unknown>)?.q as string || queryForProvider;
    return { results, queryText };
  } catch (err: unknown) {
    // user cancellation: propagate
    if (signal?.aborted) throw err;
    // timeout or other error: convert to meaningful message
    const message = (err as Error).name === 'AbortError'
      ? `Search timed out after ${getConfig().search.requestTimeoutMs / 1000}s`
      : (err as Error).message || 'Search failed';
    throw new Error(message);
  } finally {
    clean();
  }
}

/** Serper (Google SERP). Docs: https://serper.dev/api-docs */
export const serperProvider: SearchProvider = {
  id: 'serper',
  isConfigured: () => loadSettings().searchProviders.serper?.keys.some((key) => key.trim().length > 0) ?? false,
  search: serperSearch,
  reset: () => { ring.reset(); },
};
