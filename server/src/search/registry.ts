import { loadSettings } from '../settings-store.js';
import { serperProvider } from './serper.js';
import { youcomProvider } from './youcom.js';
import { serpapiProvider } from './serpapi.js';
import { tavilyProvider } from './tavily.js';
import { linkupProvider } from './linkup.js';
import { braveProvider } from './brave.js';
import { parallelProvider } from './parallel.js';
import { octenProvider } from './octen.js';
import { firecrawlProvider } from './firecrawl.js';
import { exaProvider } from './exa.js';
import { brightdataProvider } from './brightdata.js';
import { serplyProvider } from './serply.js';
import { valyuProvider } from './valyu.js';
import { jinaProvider } from './jina.js';
import { freeserpProvider } from './freeserp.js';
import { applyDepth } from './filter.js';
import type { SearchOutcome, SearchProvider, WebSearchOptions } from './types.js';

export class SearchProviderNotConfiguredError extends Error {
  constructor() {
    super('No search provider is configured. Add an API key for one of the search providers before searching.');
    this.name = 'SearchProviderNotConfiguredError';
  }
}

/**
 * The backends, in try order. Adding a provider means implementing
 * `SearchProvider` in its own module and appending it here — no other file
 * changes. `serper` stays first so an existing single-provider setup behaves
 * exactly as before.
 */
const SEARCH_PROVIDERS: SearchProvider[] = [
  serperProvider,
  youcomProvider,
  serpapiProvider,
  tavilyProvider,
  linkupProvider,
  braveProvider,
  parallelProvider,
  octenProvider,
  firecrawlProvider,
  exaProvider,
  brightdataProvider,
  serplyProvider,
  valyuProvider,
  jinaProvider,
  /* Keyless last: a backend that needs no key must never shadow a keyed one
     the operator paid for. Explicit `searchProviderOrder` still wins. */
  freeserpProvider,
];

/** Try order: the configured `searchProviderOrder` first, then table order. */
function orderedProviders(): SearchProvider[] {
  const settings = loadSettings();
  const byId = new Map(SEARCH_PROVIDERS.map((provider) => [provider.id, provider]));
  const ordered: SearchProvider[] = [];
  for (const id of settings.searchProviderOrder ?? []) {
    const provider = byId.get(id);
    if (provider && !ordered.includes(provider)) ordered.push(provider);
  }
  for (const provider of SEARCH_PROVIDERS) {
    if (!ordered.includes(provider)) ordered.push(provider);
  }
  return ordered;
}

function isUsable(provider: SearchProvider): boolean {
  try {
    return provider.isConfigured();
  } catch {
    return false;
  }
}

/** True when at least one search backend can run. */
export function isSearchProviderConfigured(): boolean {
  return orderedProviders().some(isUsable);
}

/** Configured backends in try order. */
export function listSearchProviders(): SearchProvider[] {
  return orderedProviders().filter(isUsable);
}

/**
 * Searches through the configured backends in order. A backend that fails is
 * skipped in favour of the next one; only when every configured backend fails
 * does the call fail. User cancellation is never swallowed: an aborted signal
 * propagates immediately instead of falling through.
 */
export async function searchResults(
  query: string,
  type: string = 'search',
  signal?: AbortSignal,
  limit?: number,
  options: WebSearchOptions = {},
): Promise<SearchOutcome> {
  const configured = listSearchProviders();
  if (configured.length === 0) throw new SearchProviderNotConfiguredError();
  let lastError: unknown = null;
  for (const provider of configured) {
    try {
      const outcome = await provider.search(query, type, signal, limit, options);
      const processed = await applyDepth(outcome, options, signal);
      return { ...processed, provider: provider.id };
    } catch (err: unknown) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Search failed');
}

/** Clears cached provider state; used in tests. */
export function resetSearchProviders(): void {
  for (const provider of SEARCH_PROVIDERS) provider.reset?.();
}

/** Kept for the previous single-backend name; use {@link resetSearchProviders}. */
export function resetSerper(): void {
  resetSearchProviders();
}
