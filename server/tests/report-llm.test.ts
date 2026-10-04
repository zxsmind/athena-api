import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildEvidenceRegistry, evidenceId } from '../src/engine/report.js';
import { deriveClaimsFromAnswer, extractClaims, readAssistantText } from '../src/engine/report-llm.js';
import type { SourceWithIndex } from '../src/engine/types.js';

const callLLMMock = vi.fn();

vi.mock('../src/llm.js', () => ({
  callLLM: (...args: unknown[]) => callLLMMock(...args),
}));

beforeEach(() => {
  callLLMMock.mockReset();
});

const SOURCES: SourceWithIndex[] = [
  { source_index: 1, url: 'https://example.org/a', title: 'A', domain: 'example.org', snippet: 'one' },
  { source_index: 2, url: 'https://example.org/b', title: 'B', domain: 'example.org', snippet: 'two' },
];

const REGISTRY = Array.from(buildEvidenceRegistry(SOURCES).values());

describe('deriveClaimsFromAnswer', () => {
  it('maps inline citation markers onto evidence IDs', () => {
    const claims = deriveClaimsFromAnswer('Rules changed in 2026 [1]. Fees stayed flat [2].', REGISTRY);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ text: 'Rules changed in 2026.', citation_ids: [evidenceId(1)] });
    expect(claims[1]).toMatchObject({ text: 'Fees stayed flat.', citation_ids: [evidenceId(2)] });
  });

  it('supports multi-source markers and de-duplicates them', () => {
    const claims = deriveClaimsFromAnswer('Widely reported [1, 2, 1].', REGISTRY);
    expect(claims[0].citation_ids).toEqual([evidenceId(1), evidenceId(2)]);
  });

  it('drops markers that are not in the registry', () => {
    const claims = deriveClaimsFromAnswer('Partly known [1, 99].', REGISTRY);
    expect(claims[0].citation_ids).toEqual([evidenceId(1)]);
  });

  it('leaves uncited sentences without evidence so they become gaps', () => {
    const claims = deriveClaimsFromAnswer('Supported [1]. Uncited opinion.', REGISTRY);
    expect(claims[1]).toMatchObject({ text: 'Uncited opinion.', citation_ids: [] });
  });

  it('returns nothing for an empty answer', () => {
    expect(deriveClaimsFromAnswer('   ', REGISTRY)).toEqual([]);
  });

  it('keeps markers trailing their sentence after a period and space', () => {
    /* The model writes "...2026. [1]" with a space. Splitting between the
       period and the marker orphaned every citation into a marker-only
       segment that was then discarded. */
    const claims = deriveClaimsFromAnswer('Rules changed in 2026. [1]\n\nFees stayed flat [2].', REGISTRY);
    expect(claims[0]).toMatchObject({ text: 'Rules changed in 2026.', citation_ids: [evidenceId(1)] });
    expect(claims[1]).toMatchObject({ text: 'Fees stayed flat.', citation_ids: [evidenceId(2)] });
  });

  it('attaches a lone marker line to the claim before it', () => {
    const claims = deriveClaimsFromAnswer('Rules changed in 2026.\n[1]\nFees stayed flat.', REGISTRY);
    expect(claims[0]).toMatchObject({ text: 'Rules changed in 2026.', citation_ids: [evidenceId(1)] });
    expect(claims[1]).toMatchObject({ text: 'Fees stayed flat.', citation_ids: [] });
  });
});

describe('extractClaims', () => {
  const llmResult = (content: string) => ({
    data: { choices: [{ message: { content } }] },
  });

  it('falls back to marker mapping on a total citation wipeout', async () => {
    /* Measured: 50 valid [N] markers in prose, zero cited findings, 103 gaps.
       The extractor returned well-formed claims with empty citation_ids. */
    callLLMMock.mockResolvedValue(llmResult(JSON.stringify({
      claims: [
        { text: 'Rules changed in 2026.', citation_ids: [] },
        { text: 'Fees stayed flat.', citation_ids: [] },
      ],
    })));
    const claims = await extractClaims({
      answer: 'Rules changed in 2026 [1]. Fees stayed flat [2].',
      registry: REGISTRY,
    });
    expect(claims[0]).toMatchObject({ citation_ids: [evidenceId(1)] });
    expect(claims[1]).toMatchObject({ citation_ids: [evidenceId(2)] });
  });

  it('falls back when the extractor invents ID formats', async () => {
    callLLMMock.mockResolvedValue(llmResult(JSON.stringify({
      claims: [{ text: 'Rules changed in 2026.', citation_ids: ['1'] }],
    })));
    const claims = await extractClaims({
      answer: 'Rules changed in 2026 [1].',
      registry: REGISTRY,
    });
    expect(claims[0]).toMatchObject({ citation_ids: [evidenceId(1)] });
  });

  it('keeps a healthy extraction instead of the fallback', async () => {
    callLLMMock.mockResolvedValue(llmResult(JSON.stringify({
      claims: [{ text: 'Grouped finding.', citation_ids: [evidenceId(2)], section: 'Fees' }],
    })));
    const claims = await extractClaims({
      answer: 'Fees stayed flat [2].',
      registry: REGISTRY,
    });
    expect(claims).toMatchObject([{ text: 'Grouped finding.', section: 'Fees' }]);
  });

  it('keeps genuinely uncited claims instead of inventing links', async () => {
    callLLMMock.mockResolvedValue(llmResult(JSON.stringify({
      claims: [{ text: 'Uncited opinion.', citation_ids: [] }],
    })));
    const claims = await extractClaims({
      answer: 'Uncited opinion.',
      registry: REGISTRY,
    });
    expect(claims).toMatchObject([{ text: 'Uncited opinion.', citation_ids: [] }]);
  });
});

describe('readAssistantText', () => {
  it('extracts message content from the OpenAI-shaped result', () => {
    expect(readAssistantText({ choices: [{ message: { content: '{"claims":[]}' } }] })).toBe('{"claims":[]}');
  });

  it('returns an empty string when the shape is unexpected', () => {
    expect(readAssistantText(null)).toBe('');
    expect(readAssistantText({ choices: [] })).toBe('');
    expect(readAssistantText({ choices: [{ message: {} }] })).toBe('');
  });
});
