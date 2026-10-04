import { describe, expect, it } from 'vitest';
import { rankProviders, scoreProvider, parseList } from '../src/cli/setup.js';

interface Entry {
  id: string;
  name: string;
  modelCount: number;
}

const provider = (id: string, name: string, modelCount = 1): Entry => ({ id, name, modelCount });

const catalog: Entry[] = [
  provider('openai', 'OpenAI', 40),
  provider('openai-compatible', 'OpenAI Compatible', 2),
  provider('azure', 'Azure', 30),
  provider('google', 'Google', 60),
  provider('google-vertex', 'Google Vertex', 20),
  provider('anthropic', 'Anthropic', 16),
  provider('groq', 'Groq', 25),
  provider('openrouter', 'OpenRouter', 300),
];

describe('scoreProvider', () => {
  it('matches everything with an empty term', () => {
    expect(scoreProvider(catalog[0], [])).toBe(0);
  });

  it('ranks an exact id above a prefix match', () => {
    expect(scoreProvider(provider('openai', 'OpenAI'), ['openai']))
      .toBeGreaterThan(scoreProvider(provider('openai-compatible', 'OpenAI Compatible'), ['openai']));
  });

  it('ranks a prefix match above a substring match', () => {
    expect(scoreProvider(provider('openrouter', 'OpenRouter'), ['open']))
      .toBeGreaterThan(scoreProvider(provider('my-open-proxy', 'My Open Proxy'), ['open']));
  });

  it('ranks an id match above a name match', () => {
    expect(scoreProvider(provider('vertex', 'Vertex'), ['vertex']))
      .toBeGreaterThan(scoreProvider(provider('gcp', 'Vertex on GCP'), ['vertex']));
  });

  it('rejects a term that matches nothing', () => {
    expect(scoreProvider(provider('openai', 'OpenAI'), ['zzz'])).toBe(-1);
  });

  it('requires every term to match', () => {
    /* "compatible" is absent from plain OpenAI, so the pair must not match. */
    expect(scoreProvider(provider('openai', 'OpenAI'), ['openai', 'compatible'])).toBe(-1);
    expect(scoreProvider(provider('openai-compatible', 'OpenAI Compatible'), ['openai', 'compatible']))
      .toBeGreaterThan(0);
  });

  it('matches a subsequence so typos still find the provider', () => {
    expect(scoreProvider(provider('openrouter', 'OpenRouter'), ['opnrt'])).toBeGreaterThan(0);
  });
});

describe('rankProviders', () => {
  it('returns the whole catalog for an empty term', () => {
    /* The bug this guards: the search used to slice to 30 entries, so an empty
       term showed only 30 of the catalog providers. */
    expect(rankProviders(catalog, '')).toHaveLength(catalog.length);
  });

  it('never truncates a large catalog', () => {
    const many = Array.from({ length: 225 }, (_, index) => provider(`p${index}`, `Provider ${index}`));
    expect(rankProviders(many, '')).toHaveLength(225);
    expect(rankProviders(many, 'provider')).toHaveLength(225);
  });

  it('puts the best match first', () => {
    expect(rankProviders(catalog, 'anthropic')[0].id).toBe('anthropic');
    expect(rankProviders(catalog, 'openai')[0].id).toBe('openai');
    expect(rankProviders(catalog, 'google')[0].id).toBe('google');
  });

  it('filters out non-matching entries', () => {
    const ids = rankProviders(catalog, 'anthropic').map((entry) => entry.id);
    expect(ids).toEqual(['anthropic']);
  });

  it('handles multi-word input', () => {
    const ids = rankProviders(catalog, 'google vertex').map((entry) => entry.id);
    expect(ids).toEqual(['google-vertex']);
  });

  it('is stable for equal scores', () => {
    const first = rankProviders(catalog, 'o').map((entry) => entry.id);
    const second = rankProviders(catalog, 'o').map((entry) => entry.id);
    expect(first).toEqual(second);
  });

  it('returns nothing when nothing matches', () => {
    expect(rankProviders(catalog, 'nonexistentprovider')).toEqual([]);
  });

  it('is case insensitive', () => {
    expect(rankProviders(catalog, 'ANTHROPIC')[0].id).toBe('anthropic');
  });
});

describe('parseList', () => {
  it('splits on commas, spaces, and newlines', () => {
    expect(parseList('a, b\nc d;e')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops empties', () => {
    expect(parseList('  , ,')).toEqual([]);
    expect(parseList('')).toEqual([]);
  });
});