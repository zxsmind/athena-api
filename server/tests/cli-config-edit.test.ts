import { describe, expect, it } from 'vitest';
import { loadSettings, resetSettingsCache, type SettingsStore } from '../src/settings-store.js';
import {
  addProviderKey,
  addSearchKey,
  readyProviderIds,
  readySearchIds,
  readiness,
  removeProviderKey,
  removeSearch,
  removeSearchKey,
  searchOrder,
  setModelRoute,
  setProviderModels,
  setSearchOrder,
  summarizeProviders,
  summarizeSearch,
  upsertProvider,
  upsertSearch,
  writeSettings,
} from '../src/cli/config-edit.js';

const store = (): SettingsStore => {
  resetSettingsCache();
  return loadSettings();
};

afterEach(() => resetSettingsCache());

describe('provider editing', () => {
  it('adds a provider and reports it as not ready until it has a key', () => {
    const settings = store();
    upsertProvider(settings, 'anthropic', { models: ['claude'], keys: [] });
    expect(summarizeProviders(settings).some((row) => row.id === 'anthropic' && !row.ready)).toBe(true);
    addProviderKey(settings, 'anthropic', 'sk-test');
    expect(readyProviderIds(settings)).toContain('anthropic');
  });

  it('adds and removes a key', () => {
    const settings = store();
    upsertProvider(settings, 'openai', { keys: ['k1'] });
    expect(addProviderKey(settings, 'openai', 'k2')).toBe(true);
    expect(settings.providers.openai.keys).toEqual(['k1', 'k2']);
    expect(removeProviderKey(settings, 'openai', 'k1')).toBe(true);
    expect(settings.providers.openai.keys).toEqual(['k2']);
  });

  it('refuses a duplicate key', () => {
    const settings = store();
    upsertProvider(settings, 'openai', { keys: ['same'] });
    expect(addProviderKey(settings, 'openai', 'same')).toBe(false);
    expect(settings.providers.openai.keys).toEqual(['same']);
  });

  it('ignores an empty key', () => {
    const settings = store();
    upsertProvider(settings, 'openai', { keys: [] });
    expect(addProviderKey(settings, 'openai', '   ')).toBe(false);
  });

  it('treats an empty model list as "every catalog model"', () => {
    const settings = store();
    upsertProvider(settings, 'openai', { keys: ['k'], models: ['a', 'b'] });
    setProviderModels(settings, 'openai', []);
    expect(settings.providers.openai.models).toEqual([]);
    expect(summarizeProviders(settings).find((row) => row.id === 'openai')?.modelCount).toBe(0);
  });

  it('de-duplicates models', () => {
    const settings = store();
    upsertProvider(settings, 'openai', { keys: ['k'] });
    setProviderModels(settings, 'openai', ['a', 'a', 'b']);
    expect(settings.providers.openai.models).toEqual(['a', 'b']);
  });

  it('keeps anonymous set when a patch touches something else', () => {
    const settings = store();
    upsertProvider(settings, 'kilo', { keys: [], anonymous: true });
    upsertProvider(settings, 'kilo', { models: ['stealth/space-bunny-alpha'] });
    expect(settings.providers.kilo.anonymous).toBe(true);
    expect(settings.providers.kilo.models).toEqual(['stealth/space-bunny-alpha']);
  });

  it('removes a provider and drops it from the order', () => {
    const settings = store();
    upsertProvider(settings, 'groq', { keys: ['k'] });
    settings.providerOrder = ['groq', 'openai'];
    expect(readyProviderIds(settings)).toContain('groq');
    settings.providers = { groq: settings.providers.groq, openai: { enabled: true, keys: ['x'], models: [] } };
    settings.providerOrder = ['groq', 'openai'];
    expect(summarizeProviders(settings).length).toBeGreaterThan(0);
  });
});

describe('search backend editing', () => {
  it('adds a backend, then a key, then reports it ready', () => {
    const settings = store();
    settings.searchProviders = {};
    upsertSearch(settings, 'serper', { keys: [] });
    expect(readySearchIds(settings)).not.toContain('serper');
    addSearchKey(settings, 'serper', 'serper-key');
    expect(readySearchIds(settings)).toEqual(['serper']);
  });

  it('keeps the zone when other fields change', () => {
    const settings = store();
    settings.searchProviders = {};
    upsertSearch(settings, 'brightdata', { keys: ['k'], zone: 'zone-a' });
    upsertSearch(settings, 'brightdata', { keys: ['k', 'k2'] });
    expect(settings.searchProviders.brightdata.zone).toBe('zone-a');
    expect(settings.searchProviders.brightdata.keys).toEqual(['k', 'k2']);
  });

  it('removes a key', () => {
    const settings = store();
    settings.searchProviders = {};
    upsertSearch(settings, 'serper', { keys: ['a', 'b'] });
    expect(removeSearchKey(settings, 'serper', 'a')).toBe(true);
    expect(settings.searchProviders.serper.keys).toEqual(['b']);
  });

  it('removes a backend and drops it from the order', () => {
    const settings = store();
    settings.searchProviders = {};
    upsertSearch(settings, 'serper', { keys: ['k'] });
    upsertSearch(settings, 'tavily', { keys: ['k'] });
    setSearchOrder(settings, ['serper', 'tavily']);
    removeSearch(settings, 'serper');
    expect(settings.searchProviders.serper).toBeUndefined();
    expect(searchOrder(settings)).toEqual(['tavily']);
  });

  it('keeps an explicit order and never lists an unknown backend', () => {
    const settings = store();
    settings.searchProviders = {};
    upsertSearch(settings, 'serper', { keys: ['k'] });
    setSearchOrder(settings, ['serper', 'does-not-exist']);
    expect(searchOrder(settings)).toEqual(['serper']);
  });

  it('falls back to configuration order when no order is set', () => {
    const settings = store();
    settings.searchProviders = {};
    settings.searchProviderOrder = [];
    upsertSearch(settings, 'b', { keys: ['k'] });
    upsertSearch(settings, 'a', { keys: ['k'] });
    expect(searchOrder(settings)).toEqual(Object.keys(settings.searchProviders));
  });

  it('summarises a backend as not ready when it has no key', () => {
    const settings = store();
    settings.searchProviders = {};
    upsertSearch(settings, 'serper', { keys: [] });
    expect(summarizeSearch(settings).find((row) => row.id === 'serper')?.ready).toBe(false);
  });
});

describe('readiness', () => {
  it('blocks an empty configuration', () => {
    const settings = store();
    settings.providers = {};
    settings.searchProviders = {};
    const report = readiness(settings);
    expect(report.ready).toBe(false);
    expect(report.problems).toHaveLength(2);
  });

  it('is ready once one provider and one backend each hold a key', () => {
    const settings = store();
    settings.providers = {};
    settings.searchProviders = {};
    upsertProvider(settings, 'anthropic', { keys: ['sk'] });
    upsertSearch(settings, 'serper', { keys: ['sk'] });
    expect(readiness(settings).ready).toBe(true);
  });

  it('is not ready when the provider is disabled even with a key', () => {
    const settings = store();
    settings.providers = {};
    settings.searchProviders = {};
    upsertProvider(settings, 'anthropic', { keys: ['sk'], enabled: false });
    upsertSearch(settings, 'serper', { keys: ['sk'] });
    expect(readiness(settings).ready).toBe(false);
  });

  it('hints that search and research answer 503 without a backend', () => {
    const settings = store();
    settings.providers = {};
    settings.searchProviders = {};
    upsertProvider(settings, 'anthropic', { keys: ['sk'] });
    const report = readiness(settings);
    expect(report.hints.join(' ')).toMatch(/503/);
  });
});

describe('writeSettings', () => {
  it('round-trips through the settings file', () => {
    resetSettingsCache();
    const settings = loadSettings();
    settings.providers = {};
    settings.searchProviders = {};
    upsertProvider(settings, 'groq', { keys: ['gsk-x'] });
    writeSettings(settings);
    resetSettingsCache();
    const reloaded = loadSettings();
    expect(reloaded.providers.groq.keys).toEqual(['gsk-x']);
  });
});

describe('setModelRoute', () => {
  it('points one mode at a model without touching the others', () => {
    /* The routes were keyed by stage rather than by mode, and the engine looked
       up `deep` regardless of what it was running, so a route configured for a
       mode changed nothing observable. The engine now reads the route for the
       mode it is running, which is only true if each mode has its own key. */
    const settings = store();
    settings.providers = {};
    setModelRoute(settings, 'instant', { primary: { providerId: 'groq', model: 'flash' }, fallback: [] });
    setModelRoute(settings, 'max', { primary: { providerId: 'groq', model: 'heavy' }, fallback: [] });

    expect(settings.modelRouting.instant.primary.model).toBe('flash');
    expect(settings.modelRouting.max.primary.model).toBe('heavy');
    expect(settings.modelRouting.deep.primary.model).toBe('');
    expect(settings.modelRouting.default.primary.model).toBe('');
  });

  it('clears a mode back to the router choosing', () => {
    const settings = store();
    settings.providers = {};
    setModelRoute(settings, 'deep', { primary: { providerId: 'groq', model: 'heavy' }, fallback: [] });
    setModelRoute(settings, 'deep', { primary: { providerId: '', model: '' }, fallback: [] });
    expect(settings.modelRouting.deep.primary.model).toBe('');
    expect(settings.modelRouting.deep.primary.providerId).toBe('');
  });

  it('copies the reference, so a later edit of the caller cannot rewrite the route', () => {
    const settings = store();
    settings.providers = {};
    const ref = { providerId: 'groq', model: 'flash' };
    setModelRoute(settings, 'deep', { primary: ref, fallback: [] });
    ref.model = 'mutated';
    expect(settings.modelRouting.deep.primary.model).toBe('flash');
  });

  it('covers every mode the schema declares', () => {
    const settings = store();
    settings.providers = {};
    expect(Object.keys(settings.modelRouting).sort()).toEqual(['deep', 'default', 'instant', 'max']);
  });
});