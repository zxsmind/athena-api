import { describe, it, expect, vi, beforeEach } from 'vitest';

/* Mock fs — match by suffix so the absolute path from settings-store.ts resolves */
let storedContent: string | null = null;
let storedWritePath = '';

vi.mock('fs', () => ({
  readFileSync: () => {
    if (storedContent === null) throw new Error('ENOENT');
    return storedContent;
  },
  writeFileSync: (filePath: string, data: string) => {
    storedWritePath = filePath;
    storedContent = data;
  },
  existsSync: () => storedContent !== null,
  mkdirSync: () => undefined,
}));

import { loadSettings, saveSettings, resetSettingsCache, type SettingsStore, type ApiSettings } from '../src/settings-store.js';

function makeMinimalV1(): Record<string, unknown> {
  return {
    providers: {
      groq: { enabled: true, keys: ['gsk_abc'], models: ['llama-3.3-70b-versatile'], url: 'https://api.groq.com/openai/v1/chat/completions' },
    },
    serper: { keys: ['serper_key_1'], url: 'https://google.serper.dev/search' },
    searchProviders: {
      tavily: { keys: ['tvly_1', 'tvly_2'] },
    },
    general: { maxSources: 5, deepIterations: 2, thinkingStripPatterns: '<think>.*?</think>', titleModel: '' },
  };
}

function writeSettings(raw: Record<string, unknown>) {
  storedContent = JSON.stringify(raw);
}

describe('normalizeSettings', () => {
  beforeEach(() => {
    storedContent = null;
    storedWritePath = '';
    resetSettingsCache();
  });

  it('should create defaults when no file exists', () => {
    const s = loadSettings();
    expect(s.version).toBe(2);
    expect(s.port).toBe(39921);
    expect(s.host).toBe('0.0.0.0');
    /* Providers come from the catalog, so defaults list none. */
    expect(s.providers).toEqual({});
    expect(s.providerOrder).toEqual([]);
    expect(typeof s.research).toBe('object');
    expect(s.researchDepths).toBeUndefined();
    expect(s.api.defaultMaxConcurrent).toBe(2);
    expect(s.api.maxActiveJobs).toBe(50);
    expect(s.api.maxActiveBatches).toBe(50);
    expect(s.api.maxEventsPerJob).toBe(250);
    expect(s.api.maxEventsPerBatch).toBe(300);
    expect(s.api.maxRetentionMinutes).toBe(1440);
    expect(s.api.defaultMode).toBe('default');
    expect(s.modelRouting.default.primary.model).toBe('');
  });

  it('should preserve provider order from input', () => {
    const raw = makeMinimalV1();
    raw.providerOrder = ['custom', 'groq'];
    raw.providers.custom = { enabled: true, keys: [], models: [], url: '', name: 'custom' };
    writeSettings(raw);

    const s = loadSettings();
    expect(s.providerOrder[0]).toBe('custom');
    expect(s.providerOrder[1]).toBe('groq');
  });

  it('reads search backends from searchProviders and ignores any legacy field', () => {
    const raw = makeMinimalV1();
    writeSettings(raw);

    const s = loadSettings();
    /* Only the map is authoritative; the old top-level field is not migrated. */
    expect(s.searchProviders.serper).toBeUndefined();
    expect(s.searchProviders.tavily.keys).toEqual(['tvly_1', 'tvly_2']);
    expect(s.searchProviderOrder).toEqual([]);
  });

  it('should read deepIterations from general section', () => {    const raw = makeMinimalV1();
    raw.general.deepIterations = 7;
    writeSettings(raw);

    const s = loadSettings();
    expect(s.general.deepIterations).toBe(7);
  });

  it('should apply API settings when present', () => {
    const raw = makeMinimalV1();
    raw.api = {
      defaultMaxConcurrent: 4,
      maxActiveJobs: 100,
      maxActiveBatches: 30,
      maxEventsPerJob: 500,
      maxEventsPerBatch: 600,
      maxRetentionMinutes: 720,
      defaultMode: 'deep',
    };
    writeSettings(raw);

    const s = loadSettings();
    expect(s.api.defaultMaxConcurrent).toBe(4);
    expect(s.api.maxActiveJobs).toBe(100);
    expect(s.api.maxActiveBatches).toBe(30);
    expect(s.api.maxEventsPerJob).toBe(500);
    expect(s.api.maxEventsPerBatch).toBe(600);
    expect(s.api.maxRetentionMinutes).toBe(720);
    expect(s.api.defaultMode).toBe('deep');
  });

  it('should fall back to defaults for partial API settings', () => {
    const raw = makeMinimalV1();
    raw.api = { defaultMaxConcurrent: 4 };
    writeSettings(raw);

    const s = loadSettings();
    expect(s.api.defaultMaxConcurrent).toBe(4);
    expect(s.api.maxActiveJobs).toBe(50);
    expect(s.api.maxActiveBatches).toBe(50);
    expect(s.api.maxRetentionMinutes).toBe(1440);
    expect(s.api.defaultMode).toBe('default');
  });

  it('should normalize model routes', () => {
    const raw = makeMinimalV1();
    raw.modelRouting = {
      default: { primary: { providerId: 'groq', model: 'llama-3.3-70b-versatile' }, fallback: [] },
      instant: { primary: { providerId: 'gemini', model: 'gemini-2.0-flash' }, fallback: [{ providerId: 'groq', model: 'mixtral-8x7b' }] },
    };
    writeSettings(raw);

    const s = loadSettings();
    expect(s.modelRouting.default.primary.model).toBe('llama-3.3-70b-versatile');
    expect(s.modelRouting.instant.primary.model).toBe('gemini-2.0-flash');
    expect(s.modelRouting.instant.fallback[0].model).toBe('mixtral-8x7b');
    expect(s.modelRouting.deep.primary.model).toBe('');
    /* Every mode has its own route. `title` and `reasoning` were removed because
       they were stages rather than modes, `LLMRole` is derived from these keys,
       and `default` and `max` were simply absent, so a job in either mode found
       no route at all. */
    expect(Object.keys(s.modelRouting).sort()).toEqual(['deep', 'default', 'instant', 'max']);
  });

  it('should handle malformed JSON by falling back to defaults', () => {
    storedContent = 'not valid json';
    const s = loadSettings();
    expect(s.version).toBe(2);
    expect(s.port).toBe(39921);
  });
});

describe('Research settings passthrough', () => {
  beforeEach(() => {
    storedContent = null;
    resetSettingsCache();
  });

  it('should pass through research data from JSON', () => {
    const raw = makeMinimalV1();
    raw.research = { someOldField: 42 };
    writeSettings(raw);

    const s = loadSettings();
    expect(s.research.someOldField).toBe(42);
  });

  it('should default research to empty object when missing', () => {
    const raw = makeMinimalV1();
    delete raw.research;
    writeSettings(raw);

    const s = loadSettings();
    expect(typeof s.research).toBe('object');
    expect(Object.keys(s.research).length).toBe(0);
  });
});

describe('saveSettings roundtrip', () => {
  beforeEach(() => {
    storedContent = null;
    storedWritePath = '';
    resetSettingsCache();
  });

  it('should persist and reload correctly', () => {
    const customApi: ApiSettings = {
      defaultMaxConcurrent: 3,
      maxActiveJobs: 75,
      maxActiveBatches: 40,
      maxEventsPerJob: 200,
      maxEventsPerBatch: 250,
      maxRetentionMinutes: 2880,
      defaultMode: 'deep',
    };

    const store: SettingsStore = {
      version: 2,
      port: 4000,
      host: '127.0.0.1',
      providerOrder: ['groq', 'google'],
      providers: {
        groq: { enabled: true, keys: ['key1'], models: ['model-a'], url: 'http://groq.test' },
        google: { enabled: false, keys: [], models: [] },
      },
      serper: { keys: ['sk'], url: 'http://serper.test' },
      research: { maxCreditsPerQuery: 10, maxFollowUpQueries: 2 },
      modelRouting: {
        instant: { primary: { providerId: 'groq', model: 'm2' }, fallback: [] },
        default: { primary: { providerId: 'groq', model: 'm1' }, fallback: [] },
        deep: { primary: { providerId: 'groq', model: 'm3' }, fallback: [] },
        max: { primary: { providerId: 'groq', model: 'm4' }, fallback: [] },
      },
      api: customApi,
      general: { maxSources: 10, deepIterations: 5, thinkingStripPatterns: '', titleModel: '' },
    };

    saveSettings(store);
    expect(storedWritePath).toBeTruthy();
    expect(storedContent).toBeTruthy();

    const loaded = loadSettings();
    expect(loaded.port).toBe(4000);
    expect(loaded.host).toBe('127.0.0.1');
    expect(loaded.providerOrder.slice(0, 2)).toEqual(['groq', 'google']);
    expect(loaded.api.defaultMaxConcurrent).toBe(3);
    expect(loaded.api.maxRetentionMinutes).toBe(2880);
    expect(loaded.api.defaultMode).toBe('deep');
    expect(loaded.general.maxSources).toBe(10);
  });

  it('keeps provider ids exactly as written, with no id migration', () => {
    const raw = makeMinimalV1();
    raw.providers = {
      google: { enabled: true, keys: ['k'], models: ['gemini-2.5-pro'], url: 'https://generativelanguage.googleapis.com/v1beta' },
    };
    writeSettings(raw);

    const s = loadSettings();
    expect(s.providers.google.enabled).toBe(true);
    expect(s.providers.google.keys).toEqual(['k']);
    expect(s.providers.google.models).toEqual(['gemini-2.5-pro']);
  });

  it('persists and reloads as YAML', () => {
    storedContent = null;
    resetSettingsCache();
    const s = loadSettings();
    s.port = 4321;
    s.searchProviders = { tavily: { keys: ['tvly_1'] } };
    saveSettings(s);

    expect(storedWritePath.endsWith('settings.yaml')).toBe(true);
    expect(storedContent).toContain('tavily:');
    expect(storedContent).toContain('port: 4321');

    resetSettingsCache();
    const reloaded = loadSettings();
    expect(reloaded.port).toBe(4321);
    expect(reloaded.searchProviders.tavily.keys).toEqual(['tvly_1']);
  });
});
