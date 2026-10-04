/**
 * Search surface. `registry.ts` owns provider selection and fallback,
 * `filter.ts` the uniform domain/depth contract, one module per backend, and
 * `extract.ts` page extraction.
 */
export { SEARCH_TYPES, type SearchType, type WebSearchOptions, type SearchOutcome, type SearchProvider } from './types.js';
export {
  SearchProviderNotConfiguredError,
  isSearchProviderConfigured,
  listSearchProviders,
  searchResults,
  resetSearchProviders,
  resetSerper,
} from './registry.js';
export { extractPageContent, isBlockedUrl } from './extract.js';
