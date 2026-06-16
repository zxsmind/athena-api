import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsPath = resolve(__dirname, '..', '..', 'backend', 'settings.json');

export const SETTINGS_VERSION = 2;

export interface ProviderState {
  enabled: boolean;
  keys: string[];
  models: string[];
  url: string;
  name?: string;
}

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

export interface ApiSettings {
  defaultMaxConcurrent: number;
  maxActiveJobs: number;
  maxActiveBatches: number;
  maxEventsPerJob: number;
  maxEventsPerBatch: number;
  maxRetentionMinutes: number;
  defaultMode: 'quick' | 'deep';
}

export interface SettingsStore {
  version: number;
  port: number;
  host: string;
  providerOrder: string[];
  providers: Record<string, ProviderState>;
  serper: { keys: string[]; url: string };
  research: {
    maxCreditsPerQuery: number;
    maxFollowUpQueries: number;
  };
  modelRouting: ModelRouting;
  api: ApiSettings;
  general: {
    maxSources: number;
    deepIterations: number;
    thinkingStripPatterns: string;
    titleModel: string;
  };
}

const providerOrder = ['groq', 'gemini', 'vercel', 'openrouter', 'custom'];

function createReference(providerId = '', model = ''): ModelReference {
  return { providerId, model };
}

function createRoute(providerId = '', model = ''): ModelRoute {
  return { primary: createReference(providerId, model), fallback: [] };
}

function createModelRouting(): ModelRouting {
  return {
    title: createRoute(),
    reasoning: createRoute(),
    instant: createRoute(),
    deep: createRoute(),
  };
}

const apiDefaults: ApiSettings = {
  defaultMaxConcurrent: 2,
  maxActiveJobs: 50,
  maxActiveBatches: 50,
  maxEventsPerJob: 250,
  maxEventsPerBatch: 300,
  maxRetentionMinutes: 1440,
  defaultMode: 'quick',
};

const defaults: SettingsStore = {
  version: SETTINGS_VERSION,
  port: 3001,
  host: '0.0.0.0',
  providerOrder,
  providers: {
    groq: { enabled: false, keys: [], models: [], url: 'https://api.groq.com/openai/v1/chat/completions' },
    gemini: { enabled: false, keys: [], models: [], url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
    vercel: { enabled: false, keys: [], models: [], url: '' },
    openrouter: { enabled: false, keys: [], models: [], url: 'https://openrouter.ai/api/v1/chat/completions' },
    custom: { enabled: false, keys: [], models: [], url: '', name: 'custom' },
  },
  serper: { keys: [], url: 'https://google.serper.dev/search' },
  research: {
    maxCreditsPerQuery: 20,
    maxFollowUpQueries: 3,
  },
  modelRouting: createModelRouting(),
  api: { ...apiDefaults },
  general: { maxSources: 8, deepIterations: 3, thinkingStripPatterns: '', titleModel: '' },
};

function cloneDefaults(): SettingsStore {
  return JSON.parse(JSON.stringify(defaults)) as SettingsStore;
}

function normalizeProviderState(id: string, value: Partial<ProviderState> | undefined): ProviderState {
  const def = defaults.providers[id] || { enabled: false, keys: [], models: [], url: '', name: id };
  return {
    enabled: value?.enabled ?? def.enabled,
    keys: Array.isArray(value?.keys) ? value!.keys.filter((k): k is string => typeof k === 'string') : [...def.keys],
    models: Array.isArray(value?.models) ? value!.models.filter((m): m is string => typeof m === 'string') : [...def.models],
    url: typeof value?.url === 'string' ? value.url : def.url,
    name: typeof value?.name === 'string' ? value.name : def.name,
  };
}

function normalizeReference(value: any, fallbackProviderId = '', fallbackModel = ''): ModelReference {
  if (!value || typeof value !== 'object') return createReference(fallbackProviderId, fallbackModel);
  const providerId = typeof value.providerId === 'string' ? value.providerId.trim() : fallbackProviderId;
  const model = typeof value.model === 'string' ? value.model.trim() : fallbackModel;
  return createReference(providerId, model);
}

function normalizeRoute(value: any, fallbackProviderId = '', fallbackModel = ''): ModelRoute {
  if (!value || typeof value !== 'object') return createRoute(fallbackProviderId, fallbackModel);
  const primary = normalizeReference(value.primary, fallbackProviderId, fallbackModel);
  const fallback = Array.isArray(value.fallback)
    ? value.fallback
        .map((item: any) => normalizeReference(item))
        .filter((item: ModelReference) => item.model.length > 0 || item.providerId.length > 0)
    : [];
  return { primary, fallback };
}

function normalizeModelRouting(raw: any, providerFallbackId: string, titleFallback: string): ModelRouting {
  const base = createModelRouting();
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    title: normalizeRoute(source.title, providerFallbackId, titleFallback || base.title.primary.model),
    reasoning: normalizeRoute(source.reasoning, providerFallbackId, base.reasoning.primary.model),
    instant: normalizeRoute(source.instant, providerFallbackId, base.instant.primary.model),
    deep: normalizeRoute(source.deep, providerFallbackId, base.deep.primary.model),
  };
}

function normalizeProviderOrder(
  rawOrder: unknown,
  providers: Record<string, ProviderState>,
  sourceOrder: string[],
): string[] {
  const order = Array.isArray(rawOrder)
    ? rawOrder.filter((id): id is string => typeof id === 'string' && !!providers[id])
    : [];
  const merged = new Set(order);
  for (const id of sourceOrder) {
    if (providers[id]) merged.add(id);
  }
  for (const id of Object.keys(providers)) {
    merged.add(id);
  }
  return Array.from(merged);
}

function normalizeSettings(raw: any): SettingsStore {
  const merged = cloneDefaults();
  const providers = Object.keys(merged.providers);
  const sourceProviders = raw && typeof raw.providers === 'object' ? raw.providers : {};
  for (const id of providers) {
    merged.providers[id] = normalizeProviderState(id, sourceProviders[id]);
  }
  const titleFallback = typeof raw?.general?.titleModel === 'string' ? raw.general.titleModel : '';
  merged.version = SETTINGS_VERSION;
  merged.port = typeof raw?.port === 'number' ? raw.port : merged.port;
  merged.host = typeof raw?.host === 'string' ? raw.host : merged.host;
  merged.providerOrder = normalizeProviderOrder(raw?.providerOrder, merged.providers, Object.keys(sourceProviders));
  merged.serper = {
    keys: Array.isArray(raw?.serper?.keys) ? raw.serper.keys.filter((k: any) => typeof k === 'string') : [...merged.serper.keys],
    url: typeof raw?.serper?.url === 'string' ? raw.serper.url : merged.serper.url,
  };
  merged.research = {
    maxCreditsPerQuery: typeof raw?.research?.maxCreditsPerQuery === 'number' ? raw.research.maxCreditsPerQuery : merged.research.maxCreditsPerQuery,
    maxFollowUpQueries: typeof raw?.research?.maxFollowUpQueries === 'number' ? raw.research.maxFollowUpQueries : merged.research.maxFollowUpQueries,
  };
  merged.general = {
    maxSources: typeof raw?.general?.maxSources === 'number' ? raw.general.maxSources : merged.general.maxSources,
    deepIterations: typeof raw?.general?.deepIterations === 'number' ? raw.general.deepIterations : merged.general.deepIterations,
    thinkingStripPatterns: typeof raw?.general?.thinkingStripPatterns === 'string' ? raw.general.thinkingStripPatterns : merged.general.thinkingStripPatterns,
    titleModel: titleFallback,
  };
  merged.modelRouting = normalizeModelRouting(raw?.modelRouting, merged.providerOrder[0] || 'groq', titleFallback);
  merged.api = raw?.api && typeof raw.api === 'object' ? {
    defaultMaxConcurrent: typeof raw.api.defaultMaxConcurrent === 'number' ? raw.api.defaultMaxConcurrent : apiDefaults.defaultMaxConcurrent,
    maxActiveJobs: typeof raw.api.maxActiveJobs === 'number' ? raw.api.maxActiveJobs : apiDefaults.maxActiveJobs,
    maxActiveBatches: typeof raw.api.maxActiveBatches === 'number' ? raw.api.maxActiveBatches : apiDefaults.maxActiveBatches,
    maxEventsPerJob: typeof raw.api.maxEventsPerJob === 'number' ? raw.api.maxEventsPerJob : apiDefaults.maxEventsPerJob,
    maxEventsPerBatch: typeof raw.api.maxEventsPerBatch === 'number' ? raw.api.maxEventsPerBatch : apiDefaults.maxEventsPerBatch,
    maxRetentionMinutes: typeof raw.api.maxRetentionMinutes === 'number' ? raw.api.maxRetentionMinutes : apiDefaults.maxRetentionMinutes,
    defaultMode: raw.api.defaultMode === 'quick' || raw.api.defaultMode === 'deep' ? raw.api.defaultMode : apiDefaults.defaultMode,
  } : { ...apiDefaults };
  return merged;
}

let settingsCache: SettingsStore | null = null;
let settingsCacheTime = 0;
const CACHE_TTL_MS = 2000;

export function loadSettings(): SettingsStore {
  const now = Date.now();
  if (settingsCache && (now - settingsCacheTime) < CACHE_TTL_MS) {
    return settingsCache;
  }
  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      settingsCache = normalizeSettings(JSON.parse(raw));
      settingsCacheTime = now;
      return settingsCache;
    } catch { /* fall through */ }
  }

  const def = cloneDefaults();
  saveSettings(def);
  return def;
}

export function saveSettings(store: SettingsStore): void {
  const normalized = normalizeSettings(store);
  writeFileSync(settingsPath, JSON.stringify(normalized, null, 2), 'utf-8');
  settingsCache = normalized;
  settingsCacheTime = Date.now();
}

export function resetSettingsCache(): void {
  settingsCache = null;
  settingsCacheTime = 0;
}

export function getEnabledProviders(): string[] {
  const s = loadSettings();
  return s.providerOrder.filter(id => s.providers[id]?.enabled);
}
