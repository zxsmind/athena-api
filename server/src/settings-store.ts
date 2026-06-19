import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsPath = resolve(__dirname, '..', 'data', 'settings.json');

export const SETTINGS_VERSION = 2;

export interface ProviderState {
  enabled: boolean;
  keys: string[];
  models: string[];
  url: string;
  name?: string;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  includeThoughts?: boolean;
  disabledThinkingModels?: string[];
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
    showDebugContext: boolean;
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
  general: { maxSources: 8, deepIterations: 3, thinkingStripPatterns: '', titleModel: '', showDebugContext: false },
};

function cloneDefaults(): SettingsStore {
  return JSON.parse(JSON.stringify(defaults)) as SettingsStore;
}

function normalizeProviderState(id: string, value: Partial<ProviderState> | undefined): ProviderState {
  const def = defaults.providers[id] || { enabled: false, keys: [], models: [], url: '', name: id };
  const rawEffort = value?.reasoningEffort;
  const validEfforts = ['none', 'minimal', 'low', 'medium', 'high'] as const;
  return {
    enabled: value?.enabled ?? def.enabled,
    keys: Array.isArray(value?.keys) ? value!.keys.filter((k): k is string => typeof k === 'string') : [...def.keys],
    models: Array.isArray(value?.models) ? value!.models.filter((m): m is string => typeof m === 'string') : [...def.models],
    url: typeof value?.url === 'string' ? value.url : def.url,
    name: typeof value?.name === 'string' ? value.name : def.name,
    reasoningEffort: typeof rawEffort === 'string' && (validEfforts as readonly string[]).includes(rawEffort) ? rawEffort as ProviderState['reasoningEffort'] : def.reasoningEffort,
    includeThoughts: typeof value?.includeThoughts === 'boolean' ? value.includeThoughts : def.includeThoughts,
    disabledThinkingModels: Array.isArray(value?.disabledThinkingModels) ? value!.disabledThinkingModels.filter((m): m is string => typeof m === 'string') : (def.disabledThinkingModels ? [...def.disabledThinkingModels] : []),
  };
}

function normalizeReference(value: unknown, fallbackProviderId = '', fallbackModel = ''): ModelReference {
  if (!value || typeof value !== 'object') return createReference(fallbackProviderId, fallbackModel);
  const v = value as Record<string, unknown>;
  const providerId = typeof v.providerId === 'string' ? (v.providerId as string).trim() : fallbackProviderId;
  const model = typeof v.model === 'string' ? (v.model as string).trim() : fallbackModel;
  return createReference(providerId, model);
}

function normalizeRoute(value: unknown, fallbackProviderId = '', fallbackModel = ''): ModelRoute {
  if (!value || typeof value !== 'object') return createRoute(fallbackProviderId, fallbackModel);
  const v = value as Record<string, unknown>;
  const primary = normalizeReference(v.primary, fallbackProviderId, fallbackModel);
  const fallback = Array.isArray(v.fallback)
    ? (v.fallback as unknown[])
        .map((item: unknown) => normalizeReference(item))
        .filter((item: ModelReference) => item.model.length > 0 || item.providerId.length > 0)
    : [];
  return { primary, fallback };
}

function normalizeModelRouting(raw: unknown, providerFallbackId: string, titleFallback: string): ModelRouting {
  const base = createModelRouting();
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
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

function normalizeSettings(raw: unknown): SettingsStore {
  const merged = cloneDefaults();
  const providers = Object.keys(merged.providers);
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sourceProviders = (r.providers && typeof r.providers === 'object' ? r.providers : {}) as Record<string, unknown>;
  for (const id of providers) {
    merged.providers[id] = normalizeProviderState(id, sourceProviders[id] as Partial<ProviderState> | undefined);
  }
  const general = (r.general && typeof r.general === 'object' ? r.general : {}) as Record<string, unknown>;
  const titleFallback = typeof general?.titleModel === 'string' ? general.titleModel as string : '';
  merged.version = SETTINGS_VERSION;
  merged.port = typeof r?.port === 'number' ? r.port as number : merged.port;
  merged.host = typeof r?.host === 'string' ? r.host as string : merged.host;
  merged.providerOrder = normalizeProviderOrder(r?.providerOrder, merged.providers, Object.keys(sourceProviders));
  const serperRaw = (r.serper && typeof r.serper === 'object' ? r.serper : {}) as Record<string, unknown>;
  merged.serper = {
    keys: Array.isArray(serperRaw?.keys) ? (serperRaw.keys as unknown[]).filter((k: unknown) => typeof k === 'string') as string[] : [...merged.serper.keys],
    url: typeof serperRaw?.url === 'string' ? serperRaw.url as string : merged.serper.url,
  };
  const researchRaw = (r.research && typeof r.research === 'object' ? r.research : {}) as Record<string, unknown>;
  merged.research = {
    maxCreditsPerQuery: typeof researchRaw?.maxCreditsPerQuery === 'number' ? researchRaw.maxCreditsPerQuery as number : merged.research.maxCreditsPerQuery,
    maxFollowUpQueries: typeof researchRaw?.maxFollowUpQueries === 'number' ? researchRaw.maxFollowUpQueries as number : merged.research.maxFollowUpQueries,
  };
  merged.general = {
    maxSources: typeof general?.maxSources === 'number' ? general.maxSources as number : merged.general.maxSources,
    deepIterations: typeof general?.deepIterations === 'number' ? general.deepIterations as number : merged.general.deepIterations,
    thinkingStripPatterns: typeof general?.thinkingStripPatterns === 'string' ? general.thinkingStripPatterns as string : merged.general.thinkingStripPatterns,
    titleModel: titleFallback,
    showDebugContext: typeof general?.showDebugContext === 'boolean' ? general.showDebugContext as boolean : merged.general.showDebugContext,
  };
  merged.modelRouting = normalizeModelRouting(r?.modelRouting, merged.providerOrder[0] || 'groq', titleFallback);
  const apiRaw = r.api && typeof r.api === 'object' ? r.api as Record<string, unknown> : null;
  merged.api = apiRaw ? {
    defaultMaxConcurrent: typeof apiRaw.defaultMaxConcurrent === 'number' ? apiRaw.defaultMaxConcurrent as number : apiDefaults.defaultMaxConcurrent,
    maxActiveJobs: typeof apiRaw.maxActiveJobs === 'number' ? apiRaw.maxActiveJobs as number : apiDefaults.maxActiveJobs,
    maxActiveBatches: typeof apiRaw.maxActiveBatches === 'number' ? apiRaw.maxActiveBatches as number : apiDefaults.maxActiveBatches,
    maxEventsPerJob: typeof apiRaw.maxEventsPerJob === 'number' ? apiRaw.maxEventsPerJob as number : apiDefaults.maxEventsPerJob,
    maxEventsPerBatch: typeof apiRaw.maxEventsPerBatch === 'number' ? apiRaw.maxEventsPerBatch as number : apiDefaults.maxEventsPerBatch,
    maxRetentionMinutes: typeof apiRaw.maxRetentionMinutes === 'number' ? apiRaw.maxRetentionMinutes as number : apiDefaults.maxRetentionMinutes,
    defaultMode: apiRaw.defaultMode === 'quick' || apiRaw.defaultMode === 'deep' ? apiRaw.defaultMode as 'quick' | 'deep' : apiDefaults.defaultMode,
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
