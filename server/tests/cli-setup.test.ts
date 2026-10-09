import { describe, expect, it } from 'vitest';
import {
  SEARCH_BACKEND_CHOICES,
  modelEffortReport,
  parseList,
  summarizeProvider,
  summarizeSearch,
} from '../src/cli/setup.js';
import type { ModelsDevSnapshot } from '../src/models-dev.js';
import type { SettingsStore } from '../src/settings-store.js';

/** A catalog with the vocabularies the resolver is checked against, so the
 *  report is tested against shapes that actually exist in models.dev. */
const snapshot = (models: Record<string, unknown>) => ({
  fetchedAt: '2026-10-09T00:00:00.000Z',
  providers: { sovinfra: { id: 'sovinfra', models } },
}) as ModelsDevSnapshot;

const settings = (models: string[]) => ({
  providers: { sovinfra: { enabled: true, keys: ['k'], models } },
}) as SettingsStore;

describe('modelEffortReport', () => {
  it('reports the values the resolver would actually send, per mode', () => {
    /* The point of the report: a mode names a rung, and what reaches the model
       depends on the model's vocabulary. */
    const report = modelEffortReport(
      snapshot({ 'gappy-model': { id: 'gappy-model', reasoning: true, reasoning_options: { type: 'effort', values: ['low', 'high', 'max'] } } }),
      settings(['gappy-model']),
    );
    expect(report.rows).toEqual([['gappy-model', 'low', 'low', 'high', 'max']]);
    expect(report.divergent).toBe(1);
  });

  it('reports a full ladder unchanged, so a nothing-to-see model is not noise', () => {
    const report = modelEffortReport(
      snapshot({ 'full-model': { id: 'full-model', reasoning: true, reasoning_options: { type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] } } }),
      settings(['full-model']),
    );
    expect(report.rows).toEqual([['full-model', 'none', 'low', 'medium', 'xhigh']]);
    expect(report.divergent).toBe(0);
  });

  it('em dashes a rung the model cannot express at all', () => {
    /* A cheap mode on a model whose floor is above it sends nothing, which the
       table has to show rather than leave blank or guess. */
    const report = modelEffortReport(
      snapshot({ 'pricey-model': { id: 'pricey-model', reasoning: true, reasoning_options: { type: 'effort', values: ['none', 'high'] } } }),
      settings(['pricey-model']),
    );
    expect(report.rows).toEqual([['pricey-model', 'none', '—', 'high', 'high']]);
    expect(report.divergent).toBe(1);
  });

  it('counts models that never think without listing them', () => {
    /* A non-reasoning model is the correct outcome, not a gap, so it is counted
       rather than given a row that would read as a problem. */
    const report = modelEffortReport(
      snapshot({ 'plain-model': { id: 'plain-model', reasoning: false } }),
      settings(['plain-model']),
    );
    expect(report.rows).toEqual([]);
    expect(report.thinkingless).toBe(1);
  });

  it('resolves a model the provider id does not cover', () => {
    /* A custom endpoint provider id matches no catalog provider, so the row is
       filled from whichever provider serves the same model id. */
    const report = modelEffortReport(
      snapshot({ 'shared-model': { id: 'shared-model', reasoning: true, reasoning_options: { type: 'effort', values: ['low', 'high', 'max'] } } }),
      { providers: { local: { enabled: true, keys: ['k'], models: ['shared-model'] } } } as SettingsStore,
    );
    expect(report.rows).toEqual([['shared-model', 'low', 'low', 'high', 'max']]);
  });

  it('says nothing when no model is configured or enabled', () => {
    expect(modelEffortReport(snapshot({}), settings([])).rows).toEqual([]);
    expect(modelEffortReport(snapshot({ 'm': { id: 'm', reasoning: true, reasoning_options: { values: [] } } }), {
      providers: { sovinfra: { enabled: false, keys: ['k'], models: ['m'] } },
    } as SettingsStore).rows).toEqual([]);
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
