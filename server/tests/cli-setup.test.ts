import { describe, expect, it } from 'vitest';
import {
  SEARCH_BACKEND_CHOICES,
  parseList,
  summarizeProvider,
  summarizeSearch,
} from '../src/cli/setup.js';

describe('parseList', () => {
  it('splits on commas, spaces, and newlines', () => {
    expect(parseList('a, b\nc d;e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops empties', () => {
    expect(parseList('  , ,')).toEqual([]);
    expect(parseList('')).toEqual([]);
  });
});

describe('summaries', () => {
  it('describes a provider entry in one line', () => {
    expect(summarizeProvider('anthropic', { enabled: true, keys: ['a', 'b'], models: [] }))
      .toBe('on anthropic — 2 keys, models: all catalog models');
    expect(summarizeProvider('x', { enabled: false, keys: ['a'], models: ['m1'], npm: '@ai-sdk/openai-compatible' }))
      .toBe('off x via @ai-sdk/openai-compatible — 1 key, models: m1');
  });

  it('describes a search entry in one line', () => {
    expect(summarizeSearch('tavily', { keys: ['a'] })).toBe('tavily — 1 key');
    expect(summarizeSearch('brightdata', { keys: ['a'], zone: 'z' })).toBe('brightdata — 1 key, zone z');
  });
});

describe('SEARCH_BACKEND_CHOICES', () => {
  it('covers every search backend id exactly once', async () => {
    const { listSearchProviders } = await import('../src/search/index.js');
    void listSearchProviders;
    const ids = SEARCH_BACKEND_CHOICES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('serper');
    expect(ids).toContain('brightdata');
    expect(ids).toContain('freeserp');
    expect(ids.length).toBe(15);
  });

  it('marks only brightdata as needing a zone', () => {
    expect(SEARCH_BACKEND_CHOICES.filter((item) => item.needsZone).map((item) => item.id)).toEqual(['brightdata']);
  });
});
