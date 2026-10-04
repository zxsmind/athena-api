import { existsSync } from 'fs';
import { getDataPath } from './storage.js';
import { readStructuredFile, writeStructuredFile } from './config-file.js';

const settingsPath = getDataPath('settings.yaml');

export const SETTINGS_VERSION = 2;

/**
 * One provider entry. The key of this entry in `SettingsStore.providers` is the
 * provider's models.dev catalog id (for example `anthropic`, `google`,
 * `openrouter`) — never an invented name. The catalog owns the provider's
 * display name, API endpoint, key env vars, runtime package, and model list;
 * every field here is an overlay on top of it:
 *
 * - `enabled`, `keys`: whether the provider is used and which keys to rotate.
 * - `models`: whitelist of catalog model ids; empty means every catalog model.
 * - `url`: baseURL override (proxy or compatible endpoint).
 * - `name`: display-name override.
 * - `npm`, `env`: only for providers the catalog does not know (a self-hosted
 *   endpoint, for example). `npm` is the AI SDK package that speaks it, `env`
 *   the environment variables a key may come from, and `models` the explicit
 *   model ids it serves.
 */
export interface ProviderState {
  enabled: boolean;
  keys: string[];
  /**
   * Keyless access: the endpoint serves anonymous callers (rate-limited),
   * so no Authorization header is sent. For providers whose free tier needs
   * no account. Never combined with keys: a present key always wins.
   */
  anonymous?: boolean;
  models: string[];
  url?: string;
  name?: string;
  npm?: string;
  env?: string[];
  /**
   * Minimum reasoning the endpoint tolerates. The mode's effort can only go
   * up from here, never down: an endpoint that rejects disabled reasoning
   * (Kilo: "reasoning is mandatory") declares its floor here instead of
   * failing every low-effort round.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  includeThoughts?: boolean;
  disabledThinkingModels?: string[];
  /**
   * Models that emit a tool call as inline JSON/XML text instead of the native
   * `tool_calls` field. The catalog cannot detect this, so it is declared here.
   */
  inlineToolCallModels?: string[];
  /**
   * Per-model price override, in US dollars per million tokens, keyed by model id.
   *
   * The models.dev catalog has no entry for a self-hosted or newly released
   * model, and `cli stats` reports those as unpriced rather than free. This is
   * where that number comes from: what the provider charges, written down by
   * whoever knows. It never reaches the model, so a wrong value misstates a
   * report and nothing else.
   */
  modelPrices?: Record<string, ModelPrice>;
}

/** US dollars per million tokens. A missing field is billed at zero. */
export interface ModelPrice {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelReference {
  providerId: string;
  model: string;
}

/**
 * One search backend entry, keyed by provider id (`serper`, `tavily`,
 * `brave`, …). Only `keys` is required; `url` overrides the default endpoint
 * and `zone` is only read by providers that need one (Bright Data).
 */
export interface SearchProviderState {
  keys: string[];
  url?: string;
  zone?: string;
  /**
   * True for backends that serve without any key (FreeSerp). Mirrors
   * `ProviderState.anonymous` on the LLM side: explicit opt-in, never default.
   */
  keyless?: boolean;
}

export interface ModelRoute {
  primary: ModelReference;
  fallback: ModelReference[];
}

/**
 * One route per research mode.
 *
 * The keys are the modes, not the stages. This used to carry `title`,
 * `reasoning`, `instant` and `deep`, which had two problems: `title` and
 * `reasoning` were never read by anything, and `default` and `max` had no entry
 * at all, so a job in either mode found no route and fell through to catalog
 * selection. `LLMRole` is derived from these keys, so a stage that is not a mode
 * cannot be a role either.
 */
export interface ModelRouting {
  instant: ModelRoute;
  default: ModelRoute;
  deep: ModelRoute;
  max: ModelRoute;
}

export interface ApiSettings {
  defaultMaxConcurrent: number;
  maxActiveJobs: number;
  maxActiveBatches: number;
  maxEventsPerJob: number;
  maxEventsPerBatch: number;
  maxRetentionMinutes: number;
  defaultMode: import('./engine/modes.js').ResearchMode;
}


export interface SettingsStore {
  version: number;
  port: number;
  host: string;
  providerOrder: string[];
  providers: Record<string, ProviderState>;
  /** Search backends by provider id. The old top-level `serper` field migrates here on load. */
  searchProviders: Record<string, SearchProviderState>;
  /** Try order for search backends; unlisted ids follow the registry order. */
  searchProviderOrder: string[];
  research: {
    [key: string]: unknown;
  };
  modelRouting: ModelRouting;
  api: ApiSettings;
  general: {
    maxSources: number;
    deepIterations: number;
    thinkingStripPatterns: string;
    titleModel: string;
    showDebugContext: boolean;
    autocompleteCount: number;
  };
}

function createReference(providerId = '', model = ''): ModelReference {
  return { providerId, model };
}

function createRoute(providerId = '', model = ''): ModelRoute {
  return { primary: createReference(providerId, model), fallback: [] };
}

function createModelRouting(): ModelRouting {
  return {
    instant: createRoute(),
    default: createRoute(),
    deep: createRoute(),
    max: createRoute(),
  };
}

const apiDefaults: ApiSettings = {
  defaultMaxConcurrent: 2,
  maxActiveJobs: 50,
  maxActiveBatches: 50,
  maxEventsPerJob: 250,
  maxEventsPerBatch: 300,
  maxRetentionMinutes: 1440,
  defaultMode: 'default',
};


const defaults: SettingsStore = {
  version: SETTINGS_VERSION,
  port: 39921,
  host: '0.0.0.0',
  providerOrder: [],
  /* No provider is listed here on purpose. Providers come from the models.dev
     catalog at runtime; settings only overlay enabled keys and model choices
     onto catalog ids. Adding a provider never touches this file. */
  providers: {},
  searchProviders: {},
  searchProviderOrder: [],
  research: {},
  modelRouting: createModelRouting(),
  api: { ...apiDefaults },
  general: { maxSources: 8, deepIterations: 3, thinkingStripPatterns: '', titleModel: '', showDebugContext: false,     autocompleteCount: 5 },
};

function cloneDefaults(): SettingsStore {
  return JSON.parse(JSON.stringify(defaults)) as SettingsStore;
}



/**
 * Keeps only usable price entries: a model id, and numbers for the fields that
 * were given. A non-number is dropped rather than coerced to zero, so a typo in
 * the settings file leaves the model unpriced instead of free.
 */
function normalizeModelPrices(value: unknown): Record<string, ModelPrice> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, ModelPrice> = {};
  for (const [modelId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const price: ModelPrice = {};
    /* Both spellings are accepted. The file is written by the CLI, which uses the
       camelCase key, while models.dev uses snake_case, and an earlier version
       read only snake_case: a price entered through the wizard was silently
       dropped on the next load and the stream reported as free. */
    const read = (key: keyof ModelPrice): void => {
      const value = entry[key] ?? (key === 'cacheRead' ? entry.cache_read : key === 'cacheWrite' ? entry.cache_write : undefined);
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) price[key] = value;
    };
    read('input');
    read('output');
    read('cacheRead');
    read('cacheWrite');
    if (Object.keys(price).length > 0) out[modelId] = price;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeProviderState(id: string, value: Partial<ProviderState> | undefined): ProviderState {
  const def = defaults.providers[id] || { enabled: false, keys: [], models: [] };
  const rawEffort = value?.reasoningEffort;
  const validEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
  const url = typeof value?.url === 'string' && value.url.length > 0 ? value.url : undefined;
  const npm = typeof value?.npm === 'string' && value.npm.length > 0 ? value.npm : undefined;
  return {
    enabled: value?.enabled ?? def.enabled ?? false,
    keys: Array.isArray(value?.keys) ? value!.keys.filter((k): k is string => typeof k === 'string') : [...(def.keys ?? [])],
    ...(typeof value?.anonymous === 'boolean' ? { anonymous: value.anonymous } : {}),
    models: Array.isArray(value?.models) ? value!.models.filter((m): m is string => typeof m === 'string') : [...(def.models ?? [])],
    ...(url ? { url } : {}),
    ...(typeof value?.name === 'string' ? { name: value.name } : def.name ? { name: def.name } : {}),
    ...(npm ? { npm } : {}),
    ...(Array.isArray(value?.env) ? { env: value!.env.filter((e): e is string => typeof e === 'string') } : {}),
    reasoningEffort: typeof rawEffort === 'string' && (validEfforts as readonly string[]).includes(rawEffort) ? rawEffort as ProviderState['reasoningEffort'] : def.reasoningEffort,
    includeThoughts: typeof value?.includeThoughts === 'boolean' ? value.includeThoughts : def.includeThoughts,
    disabledThinkingModels: Array.isArray(value?.disabledThinkingModels) ? value!.disabledThinkingModels.filter((m): m is string => typeof m === 'string') : (def.disabledThinkingModels ? [...def.disabledThinkingModels] : []),
    inlineToolCallModels: Array.isArray(value?.inlineToolCallModels) ? value!.inlineToolCallModels.filter((m): m is string => typeof m === 'string') : (def.inlineToolCallModels ? [...def.inlineToolCallModels] : []),
    ...(normalizeModelPrices(value?.modelPrices) ? { modelPrices: normalizeModelPrices(value?.modelPrices)! } : {}),
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

function normalizeModelRouting(raw: unknown, providerFallbackId: string, modelFallback: string): ModelRouting {
  const base = createModelRouting();
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fallbackModel = modelFallback || base.default.primary.model;
  return {
    instant: normalizeRoute(source.instant, providerFallbackId, fallbackModel),
    default: normalizeRoute(source.default, providerFallbackId, fallbackModel),
    deep: normalizeRoute(source.deep, providerFallbackId, fallbackModel),
    max: normalizeRoute(source.max, providerFallbackId, fallbackModel),
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

function normalizeSearchProviderState(value: unknown): SearchProviderState {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out: SearchProviderState = {
    keys: Array.isArray(v.keys) ? v.keys.filter((k): k is string => typeof k === 'string') : [],
  };
  if (typeof v.url === 'string' && v.url.length > 0) out.url = v.url;
  if (typeof v.zone === 'string' && v.zone.length > 0) out.zone = v.zone;
  if (v.keyless === true) out.keyless = true;
  return out;
}

/**
 * Search backends by id. Only `searchProviders` is read; there is no legacy
 * field and no migration.
 */
function normalizeSearchProviders(r: Record<string, unknown>): Record<string, SearchProviderState> {
  const out: Record<string, SearchProviderState> = {};
  const source = (r.searchProviders && typeof r.searchProviders === 'object' ? r.searchProviders : {}) as Record<string, unknown>;
  for (const [id, value] of Object.entries(source)) {
    if (typeof id === 'string' && id.length > 0) out[id] = normalizeSearchProviderState(value);
  }
  return out;
}

function normalizeSearchProviderOrder(rawOrder: unknown, providers: Record<string, SearchProviderState>): string[] {
  if (!Array.isArray(rawOrder)) return [];
  return rawOrder.filter((id): id is string => typeof id === 'string' && !!providers[id]);
}

function normalizeSettings(raw: unknown): SettingsStore {
  const merged = cloneDefaults();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sourceProviders = (r.providers && typeof r.providers === 'object' ? r.providers : {}) as Record<string, unknown>;
  /* Provider ids come from the file, keyed by catalog id. */
  const providers = [...new Set([...Object.keys(merged.providers), ...Object.keys(sourceProviders)])];
  for (const id of providers) {
    merged.providers[id] = normalizeProviderState(id, sourceProviders[id] as Partial<ProviderState> | undefined);
  }
  const general = (r.general && typeof r.general === 'object' ? r.general : {}) as Record<string, unknown>;
  const titleFallback = typeof general?.titleModel === 'string' ? general.titleModel as string : '';
  merged.version = SETTINGS_VERSION;
  merged.port = typeof r?.port === 'number' ? r.port as number : merged.port;
  merged.host = typeof r?.host === 'string' ? r.host as string : merged.host;
  merged.providerOrder = normalizeProviderOrder(r?.providerOrder, merged.providers, Object.keys(sourceProviders));
  merged.searchProviders = normalizeSearchProviders(r);
  merged.searchProviderOrder = normalizeSearchProviderOrder(r?.searchProviderOrder, merged.searchProviders);
  merged.research = (r.research && typeof r.research === 'object' ? { ...r.research } : {});
  merged.general = {
    maxSources: typeof general?.maxSources === 'number' ? general.maxSources as number : merged.general.maxSources,
    deepIterations: typeof general?.deepIterations === 'number' ? general.deepIterations as number : merged.general.deepIterations,
    thinkingStripPatterns: typeof general?.thinkingStripPatterns === 'string' ? general.thinkingStripPatterns as string : merged.general.thinkingStripPatterns,
    titleModel: titleFallback,
    showDebugContext: typeof general?.showDebugContext === 'boolean' ? general.showDebugContext as boolean : merged.general.showDebugContext,
    autocompleteCount: typeof general?.autocompleteCount === 'number' ? general.autocompleteCount as number : merged.general.autocompleteCount,
  };
  merged.modelRouting = normalizeModelRouting(r?.modelRouting, merged.providerOrder[0] || '', titleFallback);
  const apiRaw = r.api && typeof r.api === 'object' ? r.api as Record<string, unknown> : null;
  merged.api = apiRaw ? {
    defaultMaxConcurrent: typeof apiRaw.defaultMaxConcurrent === 'number' ? apiRaw.defaultMaxConcurrent as number : apiDefaults.defaultMaxConcurrent,
    maxActiveJobs: typeof apiRaw.maxActiveJobs === 'number' ? apiRaw.maxActiveJobs as number : apiDefaults.maxActiveJobs,
    maxActiveBatches: typeof apiRaw.maxActiveBatches === 'number' ? apiRaw.maxActiveBatches as number : apiDefaults.maxActiveBatches,
    maxEventsPerJob: typeof apiRaw.maxEventsPerJob === 'number' ? apiRaw.maxEventsPerJob as number : apiDefaults.maxEventsPerJob,
    maxEventsPerBatch: typeof apiRaw.maxEventsPerBatch === 'number' ? apiRaw.maxEventsPerBatch as number : apiDefaults.maxEventsPerBatch,
    maxRetentionMinutes: typeof apiRaw.maxRetentionMinutes === 'number' ? apiRaw.maxRetentionMinutes as number : apiDefaults.maxRetentionMinutes,
    defaultMode: apiRaw.defaultMode === 'default' || apiRaw.defaultMode === 'deep' || apiRaw.defaultMode === 'max' ? apiRaw.defaultMode as import('./engine/modes.js').ResearchMode : apiDefaults.defaultMode,
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
  /* A settings file that exists but cannot be parsed is a problem to report,
     not a file to replace. It holds API keys, and writing defaults over it
     destroyed a working configuration once already: a locked or half-written
     file threw, the read fell through, and the empty defaults were saved on top
     of it. Losing the keys means re-issuing them; losing the routing means
     re-deciding it. */
  if (existsSync(settingsPath)) {
    try {
      settingsCache = normalizeSettings(readStructuredFile(settingsPath));
      settingsCacheTime = now;
      return settingsCache;
    } catch (error) {
      console.error(
        `[settings] ${settingsPath} could not be read; using defaults in memory and leaving the file alone. ` +
        `Fix or move the file, then restart. Cause: ${error instanceof Error ? error.message : String(error)}`,
      );
      settingsCache = cloneDefaults();
      settingsCacheTime = now;
      /* Not persisted: writing here is the destructive step being avoided. */
      return settingsCache;
    }
  }

  const def = cloneDefaults();
  saveSettings(def);
  return def;
}

export function saveSettings(store: SettingsStore): void {
  const normalized = normalizeSettings(store);
  writeStructuredFile(settingsPath, normalized);
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
