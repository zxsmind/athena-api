import type { SearchResult } from '../schemas.js';

/** Vertical names a search provider may serve. */
export const SEARCH_TYPES = ['search', 'news', 'images', 'videos', 'places', 'shopping', 'scholar', 'patents'] as const;
export type SearchType = typeof SEARCH_TYPES[number];

export interface WebSearchOptions {
  country?: string;
  language?: string;
  timeRange?: 'day' | 'week' | 'month' | 'year' | null;
  depth?: 'links' | 'passages' | 'full';
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchOutcome {
  results: SearchResult[];
  queryText: string;
  /** Id of the backend that served the query. Empty for provider modules. */
  provider?: string;
}

/**
 * One search backend. Implement this interface and append the implementation
 * to the table in `registry.ts` — no other file changes. The registry tries
 * configured providers in order, so the first configured provider serves.
 */
export interface SearchProvider {
  /** Stable id, used in logs and errors. */
  id: string;
  /** True when the provider has what it needs to run (usually a key). */
  isConfigured(): boolean;
  search(
    query: string,
    type: string,
    signal: AbortSignal | undefined,
    limit: number | undefined,
    options: WebSearchOptions,
  ): Promise<SearchOutcome>;
  /** Clears cached key rotation or connections; called in tests. */
  reset?(): void;
}
