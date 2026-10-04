import { describe, it, expect } from 'vitest';
import {
  createResearchLedger,
  normalizeLedgerQuery,
  findPriorSearch,
  findPriorFetch,
  recordLedgerSearch,
  recordLedgerFetch,
  duplicateSearchToolMessage,
} from '../src/engine/research-ledger.js';

describe('research-ledger', () => {
  it('normalizes queries for dedup', () => {
    expect(normalizeLedgerQuery('  EV   Sales   Turkey  ')).toBe('ev sales turkey');
  });

  it('finds prior search by normalized query', () => {
    const ledger = createResearchLedger();
    recordLedgerSearch(ledger, 'Türkiye EV satışları 2024', 0, 8, ['https://a.example']);
    const prior = findPriorSearch(ledger, 'türkiye ev satışları 2024');
    expect(prior?.resultCount).toBe(8);
    expect(findPriorSearch(ledger, 'charging infrastructure turkey')).toBeUndefined();
  });

  it('finds prior fetch by url (case-insensitive)', () => {
    const ledger = createResearchLedger();
    recordLedgerFetch(ledger, 'https://Example.com/report', 1, true, 'Report');
    expect(findPriorFetch(ledger, 'https://example.com/report')?.title).toBe('Report');
  });

  it('duplicate search message references prior round', () => {
    const ledger = createResearchLedger();
    const prior = recordLedgerSearch(ledger, 'ÖTV elektrikli araç', 2, 5, ['https://x.com']);
    const msg = duplicateSearchToolMessage(prior);
    expect(msg).toContain('round 3');
    expect(msg).toContain('https://x.com');
  });
});
