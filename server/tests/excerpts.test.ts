import { describe, expect, it } from 'vitest';
import { contentTokens, scorePassages, selectExcerpts, splitPassages } from '../src/engine/excerpts.js';

describe('excerpt selection', () => {
  it('tokenises lowercase alphanumerics of length three and up', () => {
    expect(contentTokens('Solid-State Batteries 2026!')).toEqual(['solid', 'state', 'batteries', '2026']);
  });

  it('splits on blank lines and merges stubs', () => {
    const long = 'First real paragraph with substance, long enough to stand on its own as a full passage of detailed text here and now.';
    expect(splitPassages(`Title\n\n${long}\n\nSecond one.`)).toEqual([
      `Title ${long}`,
      'Second one.',
    ]);
  });

  it('ranks passages by shared content words', () => {
    const ranked = scorePassages(
      ['Unrelated weather report.', 'The solid electrolyte conductivity enables fast charging.'],
      'solid electrolyte conductivity',
    );
    expect(ranked[1].score).toBeGreaterThan(ranked[0].score);
  });

  it('returns the matching passages as quotes within budget', () => {
    const text = 'Intro fluff with nothing relevant.\n\nThe 381 Wh/kg cell passed third-party testing in September.\n\nWeather again, nothing to see.';
    const selection = selectExcerpts(text, '381 Wh/kg third-party testing', 1_000);
    expect(selection.excerpts).toHaveLength(1);
    expect(selection.excerpts[0].text).toContain('381 Wh/kg');
  });

  it('falls back to the page head when nothing matches', () => {
    const selection = selectExcerpts('Cats and dogs.\n\nMore pets.', 'lithium electrolyte', 1_000);
    expect(selection.excerpts).toHaveLength(1);
    expect(selection.excerpts[0].text).toContain('Cats and dogs.');
  });

  it('caps excerpts and characters', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Battery density record number ${i} holds.`).join('\n\n');
    const selection = selectExcerpts(text, 'battery density record', 100, 2);
    expect(selection.excerpts.length).toBeLessThanOrEqual(2);
    expect(selection.excerpts.join(' ').length).toBeLessThanOrEqual(100);
  });

  it('is deterministic for the same inputs', () => {
    const text = 'Alpha beta gamma.\n\nDelta epsilon zeta battery.';
    const first = selectExcerpts(text, 'battery', 500);
    const second = selectExcerpts(text, 'battery', 500);
    expect(first).toEqual(second);
  });
});
