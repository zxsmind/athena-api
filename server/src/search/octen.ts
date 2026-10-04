import { loadSettings } from '../settings-store.js';
import { getConfig } from '../config/load.js';
import type { SearchResult } from '../schemas.js';
import { signalWithTimeout } from './http.js';
import { SearchProviderNotConfiguredError } from './registry.js';
import { createKeyRing } from './key-ring.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

/** Octen Web Search. Docs: https://docs.octen.ai/api-reference/search */
export const OCTEN_BASE_URL = 'https://api.octen.ai/search';

const TIME_RANGE = { day: 'day', week: 'week', month: 'month', year: 'year' } as const;

const ring = createKeyRing(() => loadSettings().searchProviders.octen?.keys ?? []);

async function octenSearch(
  query: string,
  _type: string,
  signal: AbortSignal | undefined,
  limit: number | undefined,
  options: WebSearchOptions,
): Promise<SearchOutcome> {
  /* Octen accepts 1–100 results per call. */
  const maxSources = Math.min(Math.max(limit ?? getConfig().search.defaultResultCount, 1), 100);
  const key = ring.next();
  if (!key) throw new SearchProviderNotConfiguredError();

  const base = (loadSettings().searchProviders.octen?.url ?? OCTEN_BASE_URL).replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    query,
    count: maxSources,
    highlight: { enable: true, max_tokens: 512 },
  };
  if (options.includeDomains?.length) body.include_domains = options.includeDomains;
  if (options.excludeDomains?.length) body.exclude_domains = options.excludeDomains;
  if (options.timeRange && TIME_RANGE[options.timeRange]) body.time_range = TIME_RANGE[options.timeRange];
  const { signal: timeoutSignal, clean } = signalWithTimeout(signal, getConfig().search.requestTimeoutMs);

  try {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
    if (!res.ok) throw new Error(`Octen API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as Record<string, unknown>;
    /* Octen reports success with a business code: 0 means ok. */
    if (typeof data.code === 'number' && data.code !== 0) {
      throw new Error(`Octen API error: ${String(data.msg || data.code)}`);
    }
    const payload = (data.data ?? {}) as Record<string, unknown>;
    const items = (payload.results ?? []) as unknown[];
    const results: SearchResult[] = items.slice(0, maxSources).map((item: unknown, i: number) => {
      const it = item as Record<string, unknown>;
      return {
        id: i + 1,
        title: String(it.title || ''),
        url: String(it.url || ''),
        snippet: (it.highlight || null) as string | null,
        date: (it.time_published || null) as string | null,
      };
    });
    return { results, queryText: (payload.query as string) || query };
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

export const octenProvider: SearchProvider = {
  id: 'octen',
  isConfigured: () => loadSettings().searchProviders.octen?.keys.some((key) => key.trim().length > 0) ?? false,
  search: octenSearch,
  reset: () => { ring.reset(); },
};
