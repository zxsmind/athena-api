import { describe, expect, it } from 'vitest';
import {
  assembleClaims,
  buildEvidenceRegistry,
  buildResearchReport,
  evidenceId,
  RESEARCH_REPORT_FORMAT,
  type ExtractedClaim,
} from '../src/engine/report.js';
import type { SourceWithIndex } from '../src/engine/types.js';

function source(index: number, url: string): SourceWithIndex {
  return { source_index: index, url, title: `Title ${index}`, domain: 'example.org', snippet: `Snippet ${index}` };
}

const SOURCES: SourceWithIndex[] = [
  source(1, 'https://example.org/a'),
  source(2, 'https://example.org/b'),
];

function claim(text: string, citation_ids: string[], section?: string): ExtractedClaim {
  return { text, citation_ids, section };
}

describe('evidence registry', () => {
  it('assigns stable job-local evidence IDs from the source index', () => {
    const registry = buildEvidenceRegistry(SOURCES);
    expect(registry.get(1)?.id).toBe('ev_001');
    expect(registry.get(2)?.id).toBe('ev_002');
    expect(evidenceId(12)).toBe('ev_012');
  });
});

describe('claim validation', () => {
  it('keeps findings that cite known evidence', () => {
    const result = assembleClaims([claim('Battery rules changed.', ['ev_001'])], buildEvidenceRegistry(SOURCES));
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].findings[0]).toMatchObject({ id: 'cl_1', citation_ids: ['ev_001'] });
    expect(result.gaps).toHaveLength(0);
  });

  it('rejects fabricated citation IDs and preserves the claim as a gap', () => {
    const result = assembleClaims([claim('Invented claim.', ['ev_999', 'https://evil.example'])], buildEvidenceRegistry(SOURCES));
    expect(result.sections).toHaveLength(0);
    expect(result.gaps).toEqual([{ reason: 'uncited_claim', text: 'Invented claim.', citation_ids: [] }]);
  });

  it('drops only the unknown IDs when a claim mixes valid and fabricated ones', () => {
    const result = assembleClaims([claim('Mixed.', ['ev_002', 'ev_404'])], buildEvidenceRegistry(SOURCES));
    expect(result.sections[0].findings[0].citation_ids).toEqual(['ev_002']);
  });

  it('groups findings by section and numbers them in order', () => {
    const result = assembleClaims([
      claim('First.', ['ev_001'], 'Timeline'),
      claim('Second.', ['ev_002'], 'Timeline'),
      claim('Third.', ['ev_001'], 'Impact'),
    ], buildEvidenceRegistry(SOURCES));
    expect(result.sections.map((section) => section.heading)).toEqual(['Timeline', 'Impact']);
    expect(result.sections[0].findings.map((finding) => finding.id)).toEqual(['cl_1', 'cl_2']);
  });

  it('deduplicates repeated citation IDs', () => {
    const result = assembleClaims([claim('Dup.', ['ev_001', 'ev_001'])], buildEvidenceRegistry(SOURCES));
    expect(result.sections[0].findings[0].citation_ids).toEqual(['ev_001']);
  });

  it('keeps a claim that cites evidence, because only a missing citation is a gap', () => {
    /* Replaces the test that asserted an audit-graded claim was deleted. The
       grader read 400 characters of snippet rather than the page the model had
       read, so its rejection was a statement about its own reading, and the
       claim disappeared from the answer with nothing in the response saying so.
       A claim the reader cannot check is still the reader's to judge, and the
       answer already carries the source index for it. */
    const result = assembleClaims(
      [claim('Confirmed.', ['ev_001']), claim('Cited but thin.', ['ev_002'])],
      buildEvidenceRegistry(SOURCES),
    );
    expect(result.sections[0].findings.map((finding) => finding.text)).toEqual(['Confirmed.', 'Cited but thin.']);
    expect(result.gaps).toHaveLength(0);
  });

  it('marks uncertain claims as gaps when they carry no valid citation', () => {
    const result = assembleClaims([claim('Maybe.', ['ev_777'])], buildEvidenceRegistry(SOURCES));
    expect(result.sections).toHaveLength(0);
    expect(result.gaps[0].reason).toBe('uncited_claim');
  });
});

describe('research report', () => {
  const report = () => buildResearchReport({
    question: 'Battery policy?',
    mode: 'deep',
    reasoningEffort: 'medium',
    sources: SOURCES,
    claims: [claim('Battery rules changed.', ['ev_001']), claim('Unsupported.', [])],
  });

  it('emits the versioned report envelope with the resolved controls', () => {
    const result = report();
    expect(result.format).toBe(RESEARCH_REPORT_FORMAT);
    expect(result.mode).toBe('deep');
    expect(result.reasoning_effort).toBe('medium');
    expect(result.sources.map((entry) => entry.id)).toEqual(['ev_001', 'ev_002']);
  });

  it('summarizes findings, citations, sources, and gaps consistently', () => {
    expect(report().summary).toEqual({ findings: 1, citedFindings: 1, sources: 2, gaps: 1 });
  });

  it('carries no audit block, so a response cannot claim a verification it did not do', () => {
    /* The audit ran on a snippet, not the page, and had never been measured against
       a known-bad answer. Reporting confirmed: 40 in the response implied a check
       that did not happen. */
    expect(report()).not.toHaveProperty('audit');
  });
});
