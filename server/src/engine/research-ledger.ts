/** Engine-owned research ledger: durable query/fetch history for server-side dedup. */

export interface LedgerSearchRecord {
  query: string;
  normalizedQuery: string;
  round: number;
  resultCount: number;
  topSourceUrls: string[];
  timestamp: string;
}

export interface LedgerFetchRecord {
  url: string;
  round: number;
  ok: boolean;
  title?: string;
  timestamp: string;
}

export interface ResearchLedger {
  searches: LedgerSearchRecord[];
  fetches: LedgerFetchRecord[];
}

export function createResearchLedger(): ResearchLedger {
  return { searches: [], fetches: [] };
}

export function normalizeLedgerQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function findPriorSearch(ledger: ResearchLedger, query: string): LedgerSearchRecord | undefined {
  const normalized = normalizeLedgerQuery(query);
  for (let i = ledger.searches.length - 1; i >= 0; i--) {
    if (ledger.searches[i].normalizedQuery === normalized) return ledger.searches[i];
  }
  return undefined;
}

export function findPriorFetch(ledger: ResearchLedger, url: string): LedgerFetchRecord | undefined {
  const normalized = url.trim().toLowerCase();
  for (let i = ledger.fetches.length - 1; i >= 0; i--) {
    if (ledger.fetches[i].url.trim().toLowerCase() === normalized) return ledger.fetches[i];
  }
  return undefined;
}

export function recordLedgerSearch(
  ledger: ResearchLedger,
  query: string,
  round: number,
  resultCount: number,
  topSourceUrls: string[],
): LedgerSearchRecord {
  const record: LedgerSearchRecord = {
    query: query.trim(),
    normalizedQuery: normalizeLedgerQuery(query),
    round,
    resultCount,
    topSourceUrls: topSourceUrls.slice(0, 5),
    timestamp: new Date().toISOString(),
  };
  ledger.searches.push(record);
  return record;
}

export function recordLedgerFetch(
  ledger: ResearchLedger,
  url: string,
  round: number,
  ok: boolean,
  title?: string,
): LedgerFetchRecord {
  const record: LedgerFetchRecord = {
    url: url.trim(),
    round,
    ok,
    title: title?.trim() || undefined,
    timestamp: new Date().toISOString(),
  };
  ledger.fetches.push(record);
  return record;
}

export function duplicateSearchToolMessage(prior: LedgerSearchRecord): string {
  const urls = prior.topSourceUrls.length > 0
    ? `\nTop sources from prior search: ${prior.topSourceUrls.join(', ')}`
    : '';
  return `[Duplicate search skipped — this query already ran in round ${prior.round + 1} (${prior.resultCount} results). Use the notebook and research ledger instead of repeating this query.${urls}]`;
}

export function duplicateFetchToolMessage(prior: LedgerFetchRecord): string {
  return `[Duplicate fetch skipped — ${prior.url} was already fetched in round ${prior.round + 1}${prior.ok ? '' : ' (prior attempt failed)'}. Use notebook/ledger evidence.]`;
}

