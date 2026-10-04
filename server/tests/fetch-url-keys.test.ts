import { describe, expect, it } from 'vitest';
import { fetchResultsKey, FETCH_URL_TOOL, MAX_URLS_PER_FETCH_CALL } from '../src/engine/types.js';

const fetchSchema = FETCH_URL_TOOL.function.parameters as {
  properties: { urls: { type: string; items?: { type: string }; minItems?: number; maxItems?: number } };
  required: string[];
};

describe('fetchResultsKey', () => {
  /* The bug this guards: results were stored under `callId#n` and read back
     under the bare call id, so every URL but the first looked missing and the
     run threw while pushing a fetch failure. A schema test cannot see that,
     because the schema was correct while the map keys disagreed. */
  it('gives each URL in one call its own key under the same call id', () => {
    const callId = 'call_abc';
    const keys = [1, 2, 3, 4].map((position) => fetchResultsKey(callId, position));
    expect(keys).toEqual(['call_abc#1', 'call_abc#2', 'call_abc#3', 'call_abc#4']);
    expect(new Set(keys).size).toBe(4);
  });

  it('keeps the call id recoverable so the results can go back as one tool message', () => {
    expect(fetchResultsKey('call_abc', 3).split('#')[0]).toBe('call_abc');
  });

  it('does not collide with a key from another call in the same turn', () => {
    expect(fetchResultsKey('call_abc', 1)).not.toBe(fetchResultsKey('call_xyz', 1));
  });

  it('produces a key that is absent from a fresh map, so a lookup fails loudly instead of silently', () => {
    /* Written this way because the original failure was silenced by a `!`: the
       code stored under one key and read under another, and the non-null
       assertion hid the undefined until `.push` threw on it. */
    const map = new Map<string, unknown>();
    map.set(fetchResultsKey('call_abc', 2), ['page']);
    expect(map.get('call_abc')).toBeUndefined();
    expect(map.get(fetchResultsKey('call_abc', 2))).toEqual(['page']);
  });
});

describe('FETCH_URL_TOOL', () => {
  it('takes a list of urls so several pages share one call', () => {
    expect(fetchSchema.properties.urls.type).toBe('array');
    expect(fetchSchema.properties.urls.items?.type).toBe('string');
    expect(fetchSchema.properties.urls.minItems).toBe(1);
    expect(fetchSchema.required).toContain('urls');
  });

  it('caps the list, because the pages share one context window', () => {
    expect(fetchSchema.properties.urls.maxItems).toBe(MAX_URLS_PER_FETCH_CALL);
  });
});