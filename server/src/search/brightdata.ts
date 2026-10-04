import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

/**
 * Bright Data SERP API. Docs: https://docs.brightdata.com/scraping-automation/serp-api/introduction
 *
 * Unlike the other backends this one needs a SERP zone name in addition to the
 * key, configured as `searchProviders.brightdata.zone`. The request searches
 * Google by sending a Google URL through the zone with parsed JSON output.
 */
export const BRIGHTDATA_BASE_URL = 'https://api.brightdata.com/request';

const ring = createKeyRing(() => loadSettings().searchProviders.brightdata?.keys ?? []);

async function brightdataSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  const maxSources = limit ?? getConfig().search.defaultResultCount;
  const key = ring.next();
  const entry = loadSettings().searchProviders.brightdata;
  if (!key || !entry?.zone) throw new SearchProviderNotConfiguredError();

  const base = (entry.url ?? BRIGHTDATA_BASE_URL).replace(/\/+$/, '');
  const googleParams = new URLSearchParams({ q: query, hl: options.language || 'en', gl: options.country || 'us', num: String(Math.min(maxSources, 100)) });
  const body: Record<string, unknown> = {
    zone: entry.zone,
    url: `https://www.google.com/search?${googleParams.toString()}`,
    format: 'json',
  };
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`Bright Data API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    const organic = (data.organic ?? []) as unknown[];
    const results: SearchResult[] = organic.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      return {
        id: (it.global_rank as number) ?? i + 1,
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

export const brightdataProvider: SearchProvider = {
  id: 'brightdata',
  isConfigured: () =>
    (loadSettings().searchProviders.brightdata?.keys.some((key) => key.trim().length > 0) ?? false) &&
    (loadSettings().searchProviders.brightdata?.zone?.trim().length ?? 0) > 0,
  search: brightdataSearch,
  reset: () => { ring.reset(); },
};
