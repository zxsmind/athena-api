import { loadSettings, saveSettings as storeSave, type SettingsStore } from './settings-store.js';
import { resetSerper } from './search.js';

export interface ModelReference {
  providerId: string;
  model: string;
}

export interface ModelRoute {
  primary: ModelReference;
  fallback: ModelReference[];
}

export interface ModelRouting {
  title: ModelRoute;
  reasoning: ModelRoute;
  instant: ModelRoute;
  deep: ModelRoute;
}

export interface ProviderConfig {
  enabled: boolean;
  name: string;
  keys: string[];
  models: string[];
  url: string;
  label: string;
}

export interface ApiSettingsData {
  defaultMaxConcurrent: number;
  maxActiveJobs: number;
  maxActiveBatches: number;
  maxEventsPerJob: number;
  maxEventsPerBatch: number;
  maxRetentionMinutes: number;
  defaultMode: 'quick' | 'deep';
}

export interface SettingsData {
  version: number;
  port: number;
  host: string;
  providerOrder: string[];
  providers: Record<string, ProviderConfig>;
  serper: { keys: string[]; url: string };
  research: {
    maxCreditsPerQuery: number;
    maxFollowUpQueries: number;
  };
  modelRouting: ModelRouting;
  api: ApiSettingsData;
  thinkingStripPatterns: string;
  maxSources: number;
  deepIterations: number;
}

const providerLabels: Record<string, string> = {
  groq: 'Groq',
  gemini: 'Gemini',
  vercel: 'Vercel AI Gateway',
  openrouter: 'OpenRouter',
  custom: 'Custom',
};

export function getSettings(): SettingsData {
  const store = loadSettings();
  const providers: Record<string, ProviderConfig> = {};
  for (const [id, p] of Object.entries(store.providers)) {
    providers[id] = {
      enabled: p.enabled,
      name: p.name || id,
      keys: p.keys,
      models: p.models,
      url: p.url,
      label: providerLabels[id] || id,
    };
  }

  return {
    version: store.version,
    port: store.port || 3001,
    host: store.host || '0.0.0.0',
    providerOrder: store.providerOrder,
    providers,
    serper: store.serper,
    research: store.research,
    modelRouting: store.modelRouting,
    api: store.api,
    thinkingStripPatterns: store.general.thinkingStripPatterns,
    maxSources: store.general.maxSources,
    deepIterations: store.general.deepIterations,
  };
}

export function saveSettings(data: SettingsData): void {
  const store: SettingsStore = {
    version: data.version || 2,
    port: data.port,
    host: data.host,
    providerOrder: data.providerOrder,
    providers: {},
    serper: data.serper,
    research: data.research,
    modelRouting: data.modelRouting,
    api: data.api,
    general: {
      maxSources: data.maxSources,
      deepIterations: data.deepIterations,
      thinkingStripPatterns: data.thinkingStripPatterns,
      titleModel: data.modelRouting?.title?.primary?.model || '',
    },
  };

  for (const [id, p] of Object.entries(data.providers)) {
    store.providers[id] = {
      enabled: p.enabled,
      keys: p.keys,
      models: p.models,
      url: p.url,
      name: p.name,
    };
  }

  storeSave(store);
  resetSerper();
}
