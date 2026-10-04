import { describe, expect, it } from 'vitest';
import { formatResultLine, normalizedSourceUrl, sanitizeResearchAnswer, sourceListBlock, toPublicSource } from '../src/engine/sources.js';
import type { SourceWithIndex } from '../src/engine/types.js';

function source(index: number, url: string): SourceWithIndex {
  return { source_index: index, url, title: `Title ${index}`, domain: 'example.org', snippet: `Snippet ${index}` };
}

const SOURCES = [source(1, 'https://example.org/a'), source(2, 'https://example.org/b')];

describe('normalizedSourceUrl', () => {
  it('drops the hash and trailing slash so cosmetic differences collapse', () => {
    expect(normalizedSourceUrl('https://example.org/a#section')).toBe(normalizedSourceUrl('https://example.org/a/'));
  });

  it('returns the trimmed input when the URL cannot be parsed', () => {
    expect(normalizedSourceUrl('  not-a-url  ')).toBe('not-a-url');
  });
});

describe('toPublicSource', () => {
  it('exposes only the public source fields', () => {
    expect(toPublicSource(SOURCES[0])).toEqual({
      source_index: 1,
      title: 'Title 1',
      url: 'https://example.org/a',
      domain: 'example.org',
      snippet: 'Snippet 1',
    });
  });
});

describe('sourceListBlock', () => {
  it('lists sources ordered by their source index', () => {
    const map = new Map<string, SourceWithIndex>([
      ['b', source(2, 'https://example.org/b')],
      ['a', source(1, 'https://example.org/a')],
    ]);
    expect(sourceListBlock(map)).toBe(
      '- [Source #1] Title: "Title 1" | URL: https://example.org/a\n- [Source #2] Title: "Title 2" | URL: https://example.org/b',
    );
  });

  it('tells the model when nothing has been cited yet', () => {
    expect(sourceListBlock(new Map())).toBe('No sources cited yet.');
  });
});

describe('sanitizeResearchAnswer', () => {
  it('keeps citation numbers that exist in the registry', () => {
    expect(sanitizeResearchAnswer('Rules changed [1]. Fees held [2].', SOURCES))
      .toBe('Rules changed [1]. Fees held [2].');
  });

  it('removes citation numbers that are not in the registry', () => {
    expect(sanitizeResearchAnswer('Invented [7].', SOURCES)).toBe('Invented.');
  });

  it('keeps only the valid half of a mixed citation list', () => {
    expect(sanitizeResearchAnswer('Mixed [1, 9].', SOURCES)).toBe('Mixed [1].');
  });

  it('rewrites a markdown link to a registered source as a citation', () => {
    expect(sanitizeResearchAnswer('See [the report](https://example.org/a).', SOURCES)).toBe('See [1].');
  });

  it('strips bare URLs that are not in the registry', () => {
    expect(sanitizeResearchAnswer('Claimed at https://evil.example/page.', SOURCES)).toBe('Claimed at.');
  });

  it('rewrites a registered bare URL into its citation', () => {
    expect(sanitizeResearchAnswer('Per https://example.org/b the fee held.', SOURCES)).toBe('Per [2] the fee held.');
  });

  it('strips the citation marker without leaving the label behind', () => {
    expect(sanitizeResearchAnswer('Label only [label](https://evil.example).', SOURCES)).toBe('Label only label.');
  });

  it('normalizes full-width citation brackets', () => {
    expect(sanitizeResearchAnswer('Reported 【1】.', SOURCES)).toBe('Reported [1].');
  });

  it('collapses whitespace introduced by removals', () => {
    expect(sanitizeResearchAnswer('A [9] B', SOURCES)).toBe('A B');
  });

  it('drops a leading heading and a standalone answer label, because the prompt rule did not hold', () => {
    /* The first code-engine run opened with a title heading and an answer
       label before the prose. A rule the engine can enforce belongs in the
       engine. The fixture is Turkish because the measured answer was; it
       doubles as the multi-byte case. */
    const draft = '# Ölümsüz Salyangoz: Kökeni ve Felsefi Yeri\n\n## Kısa cevap\n\nHikâye 2014\'te doğdu [1].';
    expect(sanitizeResearchAnswer(draft, SOURCES)).toBe('Hikâye 2014\'te doğdu [1].');
  });

  it('strips a same-line bold label but keeps the prose after it', () => {
    expect(sanitizeResearchAnswer('**Kısa cevap:** Hikâye 2014\'te doğdu [1].', SOURCES))
      .toBe('Hikâye 2014\'te doğdu [1].');
    expect(sanitizeResearchAnswer('**Köken:** Podcast 2014\'te yayınlandı [1].', SOURCES))
      .toBe('**Köken:** Podcast 2014\'te yayınlandı [1].');
  });

  it('keeps an answer that is only a heading, so formatting cleanup cannot empty it', () => {
    expect(sanitizeResearchAnswer('# Başlık', SOURCES)).toBe('# Başlık');
  });
});

describe('formatResultLine', () => {
  it('numbers a retrieved source so the gate and citations can see it', () => {
    const line = formatResultLine({ source_index: 7, title: 'T', url: 'https://a.example', snippet: 's' }, 1);
    expect(line).toContain('[Source #7]');
  });

  it('gives a failed retrieval no number, because it is not a source', () => {
    /* A numbered failure would force the clearing gate to demand a stored copy
       of nothing, blocking the whole message. Plain text keeps the fact while
       the gate only ever sees real sources. */
    for (const index of [0, undefined]) {
      const line = formatResultLine({ source_index: index, title: 'https://b.example', url: 'https://b.example', snippet: 'Fetch failed: 403' }, 2);
      expect(line).not.toContain('[Source #');
      expect(line).toContain('Fetch failed: 403');
      expect(line).toContain('https://b.example');
    }
  });
});
