import { describe, it, expect, vi, beforeEach } from 'vitest';

/* Mock fs — match by suffix so the absolute path from settings-store.ts resolves */
let storedContent: string | null = null;
let storedWritePath = '';

vi.mock('fs', () => ({
  readFileSync: (path: string) => {
    if (storedContent === null) throw new Error('ENOENT');
    return storedContent;
  },
  writeFileSync: (path: string, data: string) => {
    storedWritePath = path;
    storedContent = data;
  },
  existsSync: () => storedContent !== null,
}));

import { loadSettings, saveSettings, resetSettingsCache, type SettingsStore, type ApiSettings } from '../src/settings-store.js';

function makeMinimalV1(): any {
  return {
    providers: {
      groq: { enabled: true, keys: ['gsk_abc'], models: ['llama-3.3-70b-versatile'], url: 'https://api.groq.com/openai/v1/chat/completions' },
    },
    serper: { keys: ['serper_key_1'], url: 'https://google.serper.dev/search' },
    general: { maxSources: 5, deepIterations: 2, thinkingStripPatterns: '<think>.*?</think>', titleModel: '' },
  };
}

function writeSettings(raw: any) {
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
    expect(s.port).toBe(3001);
    expect(s.host).toBe('0.0.0.0');
    expect(s.providers.groq.enabled).toBe(false);
    expect(s.providers.gemini.enabled).toBe(false);
    expect(s.research.maxCreditsPerQuery).toBe(20);
    expect(s.research.maxFollowUpQueries).toBe(3);
    expect(s.api.defaultMaxConcurrent).toBe(2);
    expect(s.api.maxActiveJobs).toBe(50);
    expect(s.api.maxActiveBatches).toBe(50);
    expect(s.api.maxEventsPerJob).toBe(250);
    expect(s.api.maxEventsPerBatch).toBe(300);
    expect(s.api.maxRetentionMinutes).toBe(1440);
    expect(s.api.defaultMode).toBe('quick');
    expect(s.modelRouting.title.primary.model).toBe('');
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

  it('should read deepIterations from general section', () => {
    const raw = makeMinimalV1();
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
    expect(s.api.defaultMode).toBe('quick');
  });

  it('should normalize model routes', () => {
    const raw = makeMinimalV1();
    raw.modelRouting = {
      title: { primary: { providerId: 'groq', model: 'llama-3.3-70b-versatile' }, fallback: [] },
      instant: { primary: { providerId: 'gemini', model: 'gemini-2.0-flash' }, fallback: [{ providerId: 'groq', model: 'mixtral-8x7b' }] },
    };
    writeSettings(raw);

    const s = loadSettings();
    expect(s.modelRouting.title.primary.model).toBe('llama-3.3-70b-versatile');
    expect(s.modelRouting.instant.primary.model).toBe('gemini-2.0-flash');
    expect(s.modelRouting.instant.fallback[0].model).toBe('mixtral-8x7b');
    expect(s.modelRouting.deep.primary.model).toBe('');
  });

  it('should handle malformed JSON by falling back to defaults', () => {
    storedContent = 'not valid json';
    const s = loadSettings();
    expect(s.version).toBe(2);
    expect(s.port).toBe(3001);
  });
});

describe('Research Budget normalization', () => {
  beforeEach(() => {
    storedContent = null;
    resetSettingsCache();
  });

  it('should enforce maxCreditsPerQuery from data', () => {
    const raw = makeMinimalV1();
    raw.research = { maxCreditsPerQuery: 15, maxFollowUpQueries: 5 };
    writeSettings(raw);

    const s = loadSettings();
    expect(s.research.maxCreditsPerQuery).toBe(15);
    expect(s.research.maxFollowUpQueries).toBe(5);
  });

  it('should default research budget when missing', () => {
    const raw = makeMinimalV1();
    delete raw.research;
    writeSettings(raw);

    const s = loadSettings();
    expect(s.research.maxCreditsPerQuery).toBe(20);
    expect(s.research.maxFollowUpQueries).toBe(3);
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
      providerOrder: ['groq', 'gemini'],
      providers: {
        groq: { enabled: true, keys: ['key1'], models: ['model-a'], url: 'http://groq.test' },
        gemini: { enabled: false, keys: [], models: [], url: 'http://gemini.test' },
      },
      serper: { keys: ['sk'], url: 'http://serper.test' },
      research: { maxCreditsPerQuery: 10, maxFollowUpQueries: 2 },
      modelRouting: {
        title: { primary: { providerId: 'groq', model: 'm1' }, fallback: [] },
        reasoning: { primary: { providerId: 'groq', model: 'm4' }, fallback: [] },
        instant: { primary: { providerId: 'groq', model: 'm2' }, fallback: [] },
        deep: { primary: { providerId: 'groq', model: 'm3' }, fallback: [] },
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
    expect(loaded.providerOrder.slice(0, 2)).toEqual(['groq', 'gemini']);
    expect(loaded.api.defaultMaxConcurrent).toBe(3);
    expect(loaded.api.maxRetentionMinutes).toBe(2880);
    expect(loaded.api.defaultMode).toBe('deep');
    expect(loaded.research.maxCreditsPerQuery).toBe(10);
    expect(loaded.general.maxSources).toBe(10);
  });
});
