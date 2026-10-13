import { z } from 'zod';
import { RESEARCH_MODES } from './engine/modes.js';
import { getCachedModelsDevProvider, listCachedModelsDevProviderIds } from './models-dev.js';
import { readiness } from './cli/config-edit.js';
import { SEARCH_BACKEND_CHOICES } from './search/catalog.js';
import {
  loadSettings,
  saveSettings,
  type ModelPrice,
  type ModelReference,
  type ProviderState,
  type SearchProviderState,
  type SettingsStore,
} from './settings-store.js';

/**
 * The settings document as the operator console sees it.
 *
 * Everything here used to be reachable only through `athena config` on the
 * machine running the server, which made the console read-only in the one place
 * an operator actually goes: no model could be added, no default changed, no key
 * rotated without an SSH session. This module is the write surface that was
 * missing, and it is deliberately a thin translation over `settings-store.ts`
 * rather than a second settings format.
 *
 * Two rules shape the wire format:
 *
 * - The document is the stored one, camelCase and all. A config editor that
 *   round-trips a file must not silently drop a field it forgot to translate,
 *   so the field names here are the field names in `settings.yaml`.
 * - Secrets never leave the server. A stored key is reported as its mask, and a
 *   mask sent back means "the key that is already stored, unchanged".
 */

export const SECRET_MASK = '…';

/** Last four characters of a secret, which is enough to tell them apart. */
export function maskSecret(secret: string): string {
  return `${SECRET_MASK}${secret.slice(-4)}`;
}

export function isMaskedSecret(value: string): boolean {
  return value.startsWith(SECRET_MASK);
}

/**
 * Turns the console's key list back into stored secrets.
 *
 * An entry equal to the mask of a secret that is already stored means "that one,
 * unchanged"; anything else is a secret the operator just typed. Each stored
 * secret is claimed at most once, so two keys sharing a last four stay distinct.
 * A mask that matches nothing names a secret that is already gone, and is
 * dropped: storing the mask itself as a key would be worse than forgetting it.
 */
export function reconcileSecrets(existing: readonly string[], incoming: readonly string[]): string[] {
  const pool = [...existing];
  const out: string[] = [];
  for (const raw of incoming) {
    const value = raw.trim();
    if (value.length === 0) continue;
    if (isMaskedSecret(value)) {
      const index = pool.findIndex((candidate) => maskSecret(candidate) === value);
      if (index >= 0) out.push(pool.splice(index, 1)[0]);
      continue;
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/* ── Wire schemas ────────────────────────────────────────────────────────── */

/**
 * An id the console may name. Catalog ids look like `openrouter` or
 * `z-ai`; custom endpoints use their own slug, so the rule stays permissive
 * while still refusing anything that could escape into a file path or a header.
 */
const ProviderIdSchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a provider id: letters, digits, dot, colon, dash or underscore');

const ModelIdSchema = z.string().trim().min(1).max(400);
const SecretSchema = z.string().trim().min(1).max(400);
const OptionalTextSchema = z.string().trim().max(2048);

const ModelPriceSchema = z.object({
  input: z.number().min(0).max(1_000_000).optional(),
  output: z.number().min(0).max(1_000_000).optional(),
  cacheRead: z.number().min(0).max(1_000_000).optional(),
  cacheWrite: z.number().min(0).max(1_000_000).optional(),
});

const ProviderPatchSchema = z.object({
  enabled: z.boolean().optional(),
  /** Stored secrets, or their masks to keep what is stored. Empty clears them. */
  keys: z.array(SecretSchema).max(20).optional(),
  anonymous: z.boolean().optional(),
  /** Catalog model ids to serve. Empty means every model the catalog has. */
  models: z.array(ModelIdSchema).max(5000).optional(),
  url: OptionalTextSchema.optional(),
  name: z.string().trim().max(200).optional(),
  npm: z.string().trim().max(200).optional(),
  env: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  includeThoughts: z.boolean().optional(),
  disabledThinkingModels: z.array(ModelIdSchema).max(5000).optional(),
  inlineToolCallModels: z.array(ModelIdSchema).max(5000).optional(),
  modelPrices: z.record(ModelIdSchema, ModelPriceSchema).optional(),
});

const SearchPatchSchema = z.object({
  keys: z.array(SecretSchema).max(20).optional(),
  url: OptionalTextSchema.optional(),
  zone: z.string().trim().max(200).optional(),
  keyless: z.boolean().optional(),
});

/** An unset route names neither a provider nor a model; a set one names both. */
const ReferenceSchema = z
  .object({
    providerId: z.string().trim().max(120),
    model: z.string().trim().max(400),
  })
  .refine((ref) => (ref.providerId === '') === (ref.model === ''), {
    message: 'A route needs both a provider and a model, or neither.',
  });

const RoutePatchSchema = z.object({
  primary: ReferenceSchema.optional(),
  fallback: z.array(ReferenceSchema).max(10).optional(),
});

const GeneralPatchSchema = z.object({
  maxSources: z.number().int().min(1).max(50).optional(),
  deepIterations: z.number().int().min(1).max(20).optional(),
  thinkingStripPatterns: z.string().max(2000).optional(),
  titleModel: z.string().trim().max(400).optional(),
  showDebugContext: z.boolean().optional(),
  autocompleteCount: z.number().int().min(0).max(25).optional(),
});

const ApiPatchSchema = z.object({
  defaultMaxConcurrent: z.number().int().min(1).max(64).optional(),
  maxActiveJobs: z.number().int().min(1).max(10_000).optional(),
  maxActiveBatches: z.number().int().min(1).max(10_000).optional(),
  maxEventsPerJob: z.number().int().min(1).max(10_000).optional(),
  maxEventsPerBatch: z.number().int().min(1).max(10_000).optional(),
  maxRetentionMinutes: z.number().int().min(1).max(525_600).optional(),
  defaultMode: z.enum(RESEARCH_MODES).optional(),
});

/**
 * `null` deletes a provider or a search backend, which is how the console
 * removes one it no longer lists. Anything absent is left exactly as it is, so
 * the Models page can send a single provider without restating the rest.
 */
export const UpdateSettingsSchema = z
  .object({
    providers: z.record(ProviderIdSchema, ProviderPatchSchema.nullable()).optional(),
    providerOrder: z.array(ProviderIdSchema).max(200).optional(),
    searchProviders: z.record(ProviderIdSchema, SearchPatchSchema.nullable()).optional(),
    searchProviderOrder: z.array(ProviderIdSchema).max(200).optional(),
    /* partialRecord, not record: an enum-keyed `z.record` in Zod 4 requires every
       member to be present, so a patch that moves one mode's default was refused
       for missing the other three. Only the modes named here change. */
    modelRouting: z.partialRecord(z.enum(RESEARCH_MODES), RoutePatchSchema).optional(),
    api: ApiPatchSchema.optional(),
    general: GeneralPatchSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update.' });

export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;

/* ── Read ────────────────────────────────────────────────────────────────── */

/**
 * A route that names a model the provider does not serve.
 *
 * These are two independent knobs — which models a provider serves, and which
 * model a mode starts from — so one can be changed without the other and the
 * pair stops agreeing: uncheck the model every mode defaults to and the
 * default points at something the router will refuse. Nothing reported it, so
 * the settings screen and the models screen showed two halves of a contradiction.
 */
export function unservedRoutes(store: SettingsStore): string[] {
  const problems: string[] = [];
  for (const mode of Object.keys(store.modelRouting) as Array<keyof SettingsStore['modelRouting']>) {
    const route = store.modelRouting[mode];
    const refs: Array<{ label: string; ref: ModelReference }> = [
      { label: '', ref: route.primary },
      ...route.fallback.map((ref, index) => ({ label: ` fallback ${index + 1} of`, ref })),
    ];
    for (const { label, ref } of refs) {
      const { providerId, model } = ref;
      if (!providerId || !model) continue;
      const state = store.providers[providerId];
      if (!state?.enabled) {
        problems.push(`${mode} mode${label} points at ${model} on ${providerId}, which is not enabled.`);
        continue;
      }
      if (state.models.length > 0 && !state.models.includes(model)) {
        problems.push(
          `${mode} mode${label} points at ${model}, which ${providerId} does not serve. ` +
          `Add it under Models, or point the mode at a model that is served.`,
        );
      }
    }
  }
  return problems;
}

/** Thrown by a patch that would leave a route naming an unserved model. */
export class UnservedRouteError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
    this.name = 'UnservedRouteError';
  }
}

export interface PublicProviderState extends Omit<ProviderState, 'keys'> {
  keys: string[];
  /** How many secrets are stored, which is not the same as `keys.length` to an outsider. */
  keyCount: number;
  /** True when `models` is empty, which is what "serve the whole catalog" means. */
  servesWholeCatalog: boolean;
}

export interface PublicSearchProviderState extends Omit<SearchProviderState, 'keys'> {
  keys: string[];
  keyCount: number;
}

export interface CatalogProviderSummary {
  id: string;
  name: string;
  npm: string;
  modelCount: number;
  configured: boolean;
  enabled: boolean;
}

export interface OperatorSettings {
  providers: Record<string, PublicProviderState>;
  providerOrder: string[];
  searchProviders: Record<string, PublicSearchProviderState>;
  searchProviderOrder: string[];
  modelRouting: SettingsStore['modelRouting'];
  api: SettingsStore['api'];
  general: SettingsStore['general'];
  modes: typeof RESEARCH_MODES;
  /** Read-only: both take effect when the server binds its socket, not on save. */
  server: { port: number; host: string };
  catalog: {
    providers: CatalogProviderSummary[];
    search: Array<{ id: string; name: string; needsZone: boolean; keyless: boolean }>;
  };
  readiness: ReturnType<typeof readiness>;
}

function publicProvider(state: ProviderState): PublicProviderState {
  return {
    ...state,
    keys: state.keys.map(maskSecret),
    keyCount: state.keys.length,
    servesWholeCatalog: state.models.length === 0,
  };
}

function publicSearch(state: SearchProviderState): PublicSearchProviderState {
  return { ...state, keys: state.keys.map(maskSecret), keyCount: state.keys.length };
}

/**
 * Reads the document for the console. The catalog lists come from the on-disk
 * cache, never from the network: a settings screen that hangs when models.dev
 * is slow is worse than one whose provider picker is briefly short.
 */
export function describeSettings(store: SettingsStore = loadSettings()): OperatorSettings {
  const catalogIds = listCachedModelsDevProviderIds();
  const configured = new Set(Object.keys(store.providers));
  /* Readiness is one report: what is missing (keys, backends) and what
     contradicts itself (a route naming a model nobody serves). The console
     shows both in the same banner, so a state that cannot work is visible on
     the screen that caused it rather than only when a request fails. */
  const base = readiness(store);
  const unserved = unservedRoutes(store);
  return {
    providers: Object.fromEntries(
      Object.entries(store.providers).map(([id, state]) => [id, publicProvider(state)]),
    ),
    providerOrder: [...store.providerOrder],
    searchProviders: Object.fromEntries(
      Object.entries(store.searchProviders).map(([id, state]) => [id, publicSearch(state)]),
    ),
    searchProviderOrder: [...store.searchProviderOrder],
    modelRouting: structuredClone(store.modelRouting),
    api: { ...store.api },
    general: { ...store.general },
    modes: [...RESEARCH_MODES],
    server: { port: store.port, host: store.host },
    catalog: {
      providers: [...catalogIds]
        .sort((a, b) => a.localeCompare(b))
        .map((id) => {
          const provider = getCachedModelsDevProvider(id);
          return {
            id,
            name: provider?.name ?? id,
            npm: provider?.npm ?? '',
            modelCount: Object.keys(provider?.models ?? {}).length,
            configured: configured.has(id),
            enabled: store.providers[id]?.enabled ?? false,
          };
        }),
      search: SEARCH_BACKEND_CHOICES.map((backend) => ({
        id: backend.id,
        name: backend.label,
        needsZone: backend.needsZone,
        keyless: backend.keyless === true,
      })),
    },
    readiness: {
      ready: base.problems.length === 0 && unserved.length === 0,
      problems: [...base.problems, ...unserved],
      hints: base.hints,
    },
  };
}

/* ── Write ───────────────────────────────────────────────────────────────── */

/** An empty override means "no override", so a cleared field drops the key. */
function override(current: string | undefined, next: string | undefined): string | undefined {
  if (next === undefined) return current;
  return next.length === 0 ? undefined : next;
}

function applyProviderPatch(current: ProviderState | undefined, patch: z.infer<typeof ProviderPatchSchema>): ProviderState {
  const base: ProviderState = current ?? { enabled: true, keys: [], models: [] };
  const next: ProviderState = {
    enabled: patch.enabled ?? base.enabled,
    keys: patch.keys ? reconcileSecrets(base.keys, patch.keys) : [...base.keys],
    models: patch.models ? [...new Set(patch.models)] : [...base.models],
  };
  const anonymous = patch.anonymous ?? base.anonymous;
  if (typeof anonymous === 'boolean') next.anonymous = anonymous;
  const url = override(base.url, patch.url);
  if (url) next.url = url;
  const name = override(base.name, patch.name);
  if (name) next.name = name;
  const npm = override(base.npm, patch.npm);
  if (npm) next.npm = npm;
  if (patch.env) next.env = [...new Set(patch.env)];
  else if (base.env) next.env = [...base.env];
  const reasoningEffort = patch.reasoningEffort ?? base.reasoningEffort;
  if (reasoningEffort) next.reasoningEffort = reasoningEffort;
  if (patch.includeThoughts !== undefined) next.includeThoughts = patch.includeThoughts;
  else if (base.includeThoughts !== undefined) next.includeThoughts = base.includeThoughts;
  if (patch.disabledThinkingModels) next.disabledThinkingModels = [...new Set(patch.disabledThinkingModels)];
  else if (base.disabledThinkingModels) next.disabledThinkingModels = [...base.disabledThinkingModels];
  if (patch.inlineToolCallModels) next.inlineToolCallModels = [...new Set(patch.inlineToolCallModels)];
  else if (base.inlineToolCallModels) next.inlineToolCallModels = [...base.inlineToolCallModels];
  if (patch.modelPrices) next.modelPrices = { ...patch.modelPrices } as Record<string, ModelPrice>;
  else if (base.modelPrices) next.modelPrices = { ...base.modelPrices };
  return next;
}

function applySearchPatch(
  current: SearchProviderState | undefined,
  patch: z.infer<typeof SearchPatchSchema>,
): SearchProviderState {
  const base: SearchProviderState = current ?? { keys: [] };
  const next: SearchProviderState = {
    keys: patch.keys ? reconcileSecrets(base.keys, patch.keys) : [...base.keys],
  };
  const url = override(base.url, patch.url);
  if (url) next.url = url;
  const zone = override(base.zone, patch.zone);
  if (zone) next.zone = zone;
  const keyless = patch.keyless ?? base.keyless;
  if (keyless) next.keyless = true;
  return next;
}

/**
 * Applies a patch and writes it straight to `settings.yaml`.
 *
 * `saveSettings` refreshes the store's cache, so the router sees the change on
 * its next call: no restart, and a running job keeps the provider it started on.
 * Fields the patch does not mention are left alone, which is what lets the
 * Models page save one provider without restating the whole file.
 */
export function applySettingsPatch(patch: UpdateSettings): SettingsStore {
  const current = loadSettings();
  const next: SettingsStore = structuredClone(current);

  if (patch.providers) {
    for (const [id, providerPatch] of Object.entries(patch.providers)) {
      if (providerPatch === null) {
        delete next.providers[id];
        continue;
      }
      next.providers[id] = applyProviderPatch(next.providers[id], providerPatch);
    }
  }
  if (patch.providerOrder) {
    const known = new Set(Object.keys(next.providers));
    next.providerOrder = [...new Set(patch.providerOrder.filter((id) => known.has(id)))];
  }

  if (patch.searchProviders) {
    for (const [id, searchPatch] of Object.entries(patch.searchProviders)) {
      if (searchPatch === null) {
        delete next.searchProviders[id];
        continue;
      }
      next.searchProviders[id] = applySearchPatch(next.searchProviders[id], searchPatch);
    }
  }
  if (patch.searchProviderOrder) {
    const known = new Set(Object.keys(next.searchProviders));
    next.searchProviderOrder = [...new Set(patch.searchProviderOrder.filter((id) => known.has(id)))];
  }

  if (patch.modelRouting) {
    for (const [mode, route] of Object.entries(patch.modelRouting)) {
      const base = next.modelRouting[mode as keyof SettingsStore['modelRouting']];
      const primary = route.primary ? { ...route.primary } : { ...base.primary };
      const fallback = route.fallback ? route.fallback.map((ref) => ({ ...ref })) : base.fallback.map((ref) => ({ ...ref }));
      next.modelRouting[mode as keyof SettingsStore['modelRouting']] = { primary, fallback };
    }
  }

  if (patch.api) next.api = { ...next.api, ...stripUndefined(patch.api) };
  if (patch.general) next.general = { ...next.general, ...stripUndefined(patch.general) };

  /* Refuse the patch instead of storing it. A route naming a model the
     provider does not serve reads fine on screen and only fails when a job
     runs, and every later save would carry the contradiction forward — which
     is how two screens ended up showing opposite halves of the truth. */
  const unserved = unservedRoutes(next);
  if (unserved.length > 0) throw new UnservedRouteError(unserved);

  saveSettings(next);
  return loadSettings();
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

/* ── Model overlay helpers ───────────────────────────────────────────────── */

/**
 * Which catalog models of a provider the server will actually route to.
 *
 * An empty whitelist means the whole catalog. `provider-registry.ts` has always
 * read it that way, and `/v1/models` read it the other way round, so a
 * configured deployment listed nothing at all while the router served hundreds
 * of models. Both now call this one function.
 */
export function catalogModelsOf(state: ProviderState | undefined, catalogIds: readonly string[]): string[] {
  if (!state) return [];
  if (state.models.length === 0) return [...catalogIds];
  const wanted = new Set(state.models);
  return catalogIds.filter((id) => wanted.has(id));
}

/** Modes whose primary route names this exact provider and model. */
export function defaultModesOf(
  routing: SettingsStore['modelRouting'],
  providerId: string,
  model: string,
): string[] {
  return (Object.keys(routing) as Array<keyof SettingsStore['modelRouting']>).filter((mode) => {
    const primary: ModelReference = routing[mode].primary;
    return primary.providerId === providerId && primary.model === model;
  });
}
