/** Engine-owned research ledger: durable query/fetch history independent of LLM context compaction. */

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

export function ledgerContextBlock(ledger: ResearchLedger): string {
  if (ledger.searches.length === 0 && ledger.fetches.length === 0) {
    return 'No searches or fetches recorded yet.';
  }
  const lines: string[] = [];
  if (ledger.searches.length > 0) {
    lines.push('Completed searches (do not repeat these queries):');
    for (const s of ledger.searches.slice(-12)) {
      const urls = s.topSourceUrls.length > 0 ? ` | sources: ${s.topSourceUrls.slice(0, 3).join(', ')}` : '';
      lines.push(`- R${s.round + 1}: "${s.query}" → ${s.resultCount} results${urls}`);
    }
  }
  if (ledger.fetches.length > 0) {
    lines.push('Completed fetches:');
    for (const f of ledger.fetches.slice(-8)) {
      lines.push(`- R${f.round + 1}: ${f.url}${f.ok ? '' : ' (failed)'}${f.title ? ` — ${f.title}` : ''}`);
    }
  }
  return lines.join('\n');
}

export function compactedEvidenceNote(notebookId: string, snippetPreview: string): string {
  const preview = snippetPreview.trim().slice(0, 400);
  return `[Raw search/fetch payload compacted into notebook ${notebookId}. Evidence preserved in notebook + research ledger.${preview ? ` Preview: ${preview}${snippetPreview.length > 400 ? '…' : ''}` : ''} Continue from the notebook and ledger — do not repeat completed searches.]`;
}

export function extractSourceUrlsFromToolContent(content: string): string[] {
  const urls: string[] = [];
  const re = /URL: (https?:\/\/[^\s\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}
