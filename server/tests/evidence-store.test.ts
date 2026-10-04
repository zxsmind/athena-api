import { describe, expect, it } from 'vitest';
import { deleteEvidence, listEvidence, readEvidence, recallSource, storeEvidence } from '../src/engine/evidence-store.js';

/* DATA_DIR isolation comes from tests/setup.ts, which points every worker at a
   throwaway directory before imports. Job ids are unique per test so files in
   one worker never collide. */

let counter = 0;
function jobId(): string {
  counter += 1;
  return `evidence-test-${counter}`;
}

function store(id: string, index: number, text: string): void {
  storeEvidence(id, {
    sourceIndex: index,
    url: `https://example.org/${index}`,
    title: `Title ${index}`,
    kind: 'page',
    fetched: true,
    text,
    round: 1,
  });
}

describe('evidence store', () => {
  it('stores and reads a source by its index', () => {
    const id = jobId();
    store(id, 7, 'page text');
    const record = readEvidence(id, 7);
    expect(record?.text).toBe('page text');
    expect(record?.sourceIndex).toBe(7);
    expect(record?.fetched).toBe(true);
  });

  it('never renumbers: a second store of the same index refreshes it', () => {
    const id = jobId();
    store(id, 3, 'first');
    store(id, 3, 'second');
    expect(readEvidence(id, 3)?.text).toBe('second');
    expect(listEvidence(id)).toHaveLength(1);
  });

  it('keeps a fetched page when a later search returns a snippet for the same source', () => {
    const id = jobId();
    store(id, 3, 'Full primary record with supporting passages.');
    const page = readEvidence(id, 3);

    const stored = storeEvidence(id, {
      sourceIndex: 3, url: 'https://example.org/3', title: 'Search title',
      kind: 'search_result', fetched: false, text: 'Short search snippet.', round: 4,
    });

    expect(stored).toEqual(page);
    expect(readEvidence(id, 3)).toEqual(page);
    expect(recallSource(id, { source: 3 }).content).toContain('Full primary record with supporting passages.');
  });

  it('upgrades a search snippet when the page is fetched', () => {
    const id = jobId();
    storeEvidence(id, {
      sourceIndex: 3, url: 'https://example.org/3', title: 'Search title',
      kind: 'search_result', fetched: false, text: 'Short search snippet.', round: 0,
    });

    store(id, 3, 'Full primary record with supporting passages.');

    expect(readEvidence(id, 3)).toMatchObject({
      kind: 'page', fetched: true, text: 'Full primary record with supporting passages.',
    });
    expect(listEvidence(id)).toHaveLength(1);
  });

  it('returns null for a source that was never stored', () => {
    expect(readEvidence(jobId(), 99)).toBeNull();
  });

  it('records a hash without an LLM', () => {
    const id = jobId();
    store(id, 1, 'abc');
    expect(readEvidence(id, 1)?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recalls a byte range with the next offset', () => {
    const id = jobId();
    store(id, 2, 'abcdefghij');
    const first = recallSource(id, { source: 2, limit: 4 });
    expect(first.content).toContain('abcd');
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(4);
    const rest = recallSource(id, { source: 2, offset: first.nextOffset ?? 0 });
    expect(rest.content).toContain('efghij');
    expect(rest.truncated).toBe(false);
  });

  it('says which number to use when the lookup misses', () => {
    const view = recallSource(jobId(), { source: 42 });
    expect(view.content).toMatch(/No stored source #42/);
    expect(view.truncated).toBe(false);
  });

  it('keeps byte offsets aligned with multi-byte characters', () => {
    /* JavaScript slices by character, offsets count bytes. Cutting a
       multi-byte character in half produces invalid output and a next offset
       pointing inside a character. Both mistakes are silent, so both are
       pinned here. */
    const id = jobId();
    const text = 'Unicode plan: fees and eligibility 日本語';
    store(id, 5, text);
    const totalBytes = Buffer.byteLength(text, 'utf-8');
    let offset = 0;
    let seen = '';
    for (;;) {
      const view = recallSource(id, { source: 5, offset, limit: 7 });
      seen += view.content.split('\n\n').pop() ?? '';
      if (view.nextOffset === null) break;
      offset = view.nextOffset;
    }
    expect(seen).toBe(text);
    expect(offset).toBeLessThanOrEqual(totalBytes);
  });

  it('deletes the whole job directory on request', () => {
    const id = jobId();
    store(id, 1, 'x');
    expect(deleteEvidence(id)).toBe(true);
    expect(readEvidence(id, 1)).toBeNull();
    expect(listEvidence(id)).toEqual([]);
  });
});
