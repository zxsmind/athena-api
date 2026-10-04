import type { SearchResult } from '../schemas.js';
import { extractPageContent } from './extract.js';
import type { SearchOutcome, WebSearchOptions } from './types.js';

function safeHostname(rawUrl: string): string {
  try { return new URL(rawUrl).hostname.toLowerCase(); } catch { return ''; }
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/:?#]/, 1)[0] ?? '';
}

/** Applies the include/exclude domain filter to provider results. */
export function applyDomainFilter(results: SearchResult[], options: WebSearchOptions): SearchResult[] {
  const include = (options.includeDomains ?? []).map(normalizeDomain).filter(Boolean);
  const exclude = (options.excludeDomains ?? []).map(normalizeDomain).filter(Boolean);
  if (include.length === 0 && exclude.length === 0) return results;
  return results.filter((result) => {
    const host = safeHostname(result.url);
    if (!host) return false;
    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    return (!include.length || include.some(matches)) && !exclude.some(matches);
  });
}

/**
 * Applies the depth contract uniformly to every provider: `links` strips
 * snippets, `full` reads the top 10 pages. Providers always return snippets;
 * only this function decides what the caller sees.
 */
export async function applyDepth(
  outcome: SearchOutcome,
  options: WebSearchOptions,
  signal: AbortSignal | undefined,
): Promise<SearchOutcome> {
  const filtered = applyDomainFilter(outcome.results, options);
  if (options.depth === 'links') {
    return { ...outcome, results: filtered.map((result) => ({ ...result, snippet: null })) };
  }
  if (options.depth === 'full') {
    const expanded = await Promise.all(filtered.map(async (result, index) => {
      if (index >= 10) return result;
      const fetched = await extractPageContent(result.url, signal);
      return fetched.error
        ? { ...result, extract_error: fetched.error }
        : { ...result, title: fetched.title || result.title, content: fetched.content };
    }));
    return { ...outcome, results: expanded };
  }
  return { ...outcome, results: filtered };
}
