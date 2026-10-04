import {
  loadSettings,
  saveSettings,
  type ProviderState,
  type SearchProviderState,
  type SettingsStore,
} from '../settings-store.js';
import type { ResearchMode } from '../engine/modes.js';

/**
 * Mutations for the interactive `athena config` command.
 *
 * Every function edits the in-memory store and writes it straight back, so the
 * management surface is repeatable: nothing here depends on a wizard having run
 * first. Keep each function small and free of prompts so it stays testable.
 */

export function readSettings(): SettingsStore {
  return loadSettings();
}

export function writeSettings(settings: SettingsStore): void {
  saveSettings(settings);
}

/** Ids of providers that are enabled and hold at least one key. */
export function readyProviderIds(settings: SettingsStore): string[] {
  return Object.entries(settings.providers)
    .filter(([, state]) => state.enabled && state.keys.length > 0)
    .map(([id]) => id);
}

/** Ids of search backends that hold at least one key. */
export function readySearchIds(settings: SettingsStore): string[] {
  return Object.entries(settings.searchProviders)
    .filter(([, state]) => state.keys.length > 0)
    .map(([id]) => id);
}

export interface ProviderSummary {
  id: string;
  enabled: boolean;
  keyCount: number;
  /** Empty means "every model in the catalog". */
  modelCount: number;
  ready: boolean;
  custom: boolean;
  url: string;
}

export function summarizeProviders(settings: SettingsStore): ProviderSummary[] {
  return Object.entries(settings.providers).map(([id, state]) => ({
    id,
    enabled: state.enabled,
    keyCount: state.keys.length,
    modelCount: state.models.length,
    ready: state.enabled && state.keys.length > 0,
    custom: Boolean(state.npm) || Boolean(state.url),
    url: state.url ?? '',
  }));
}

export interface SearchSummary {
  id: string;
  keyCount: number;
  zone: string;
  url: string;
  ready: boolean;
}

export function summarizeSearch(settings: SettingsStore): SearchSummary[] {
  return Object.entries(settings.searchProviders).map(([id, state]) => ({
    id,
    keyCount: state.keys.length,
    zone: state.zone ?? '',
    url: state.url ?? '',
    ready: state.keys.length > 0,
  }));
}

/** Order the registry will try backends in, defaulting to configuration order. */
export function searchOrder(settings: SettingsStore): string[] {
  if (settings.searchProviderOrder.length > 0) return [...settings.searchProviderOrder];
  return Object.keys(settings.searchProviders);
}

export function setSearchOrder(settings: SettingsStore, order: string[]): void {
  settings.searchProviderOrder = order.filter((id) => id in settings.searchProviders);
}

export function upsertProvider(settings: SettingsStore, id: string, patch: Partial<ProviderState>): ProviderState {
  const existing = settings.providers[id];
  const next: ProviderState = {
    enabled: existing?.enabled ?? true,
    keys: existing?.keys ?? [],
    models: existing?.models ?? [],
    ...(existing?.url ? { url: existing.url } : {}),
    ...(existing?.npm ? { npm: existing.npm } : {}),
    /* Carried forward so a patch that does not mention prices, such as adding a
       key, cannot drop the prices that were already set. */
    ...(existing?.modelPrices ? { modelPrices: { ...existing.modelPrices } } : {}),
    /* Same for anonymous access: editing anything else must not silently
       re-key a keyless provider. */
    ...(typeof existing?.anonymous === 'boolean' ? { anonymous: existing.anonymous } : {}),
    ...patch,
  };
  settings.providers[id] = next;
  return next;
}

export function removeProvider(settings: SettingsStore, id: string): boolean {
  if (!(id in settings.providers)) return false;
  delete settings.providers[id];
  settings.providerOrder = settings.providerOrder.filter((entry) => entry !== id);
  return true;
}

export function addProviderKey(settings: SettingsStore, id: string, key: string): boolean {
  const trimmed = key.trim();
  const provider = settings.providers[id];
  if (!provider || trimmed.length === 0) return false;
  if (provider.keys.includes(trimmed)) return false;
  provider.keys.push(trimmed);
  return true;
}

export function removeProviderKey(settings: SettingsStore, id: string, key: string): boolean {
  const provider = settings.providers[id];
  if (!provider) return false;
  const index = provider.keys.indexOf(key);
  if (index < 0) return false;
  provider.keys.splice(index, 1);
  return true;
}

/** Empty list means "serve every model the catalog has", which is the default. */
export function setProviderModels(settings: SettingsStore, id: string, models: string[]): boolean {
  const provider = settings.providers[id];
  if (!provider) return false;
  provider.models = [...new Set(models)];
  return true;
}

/**
 * Points one research mode at a model.
 *
 * The modes are the keys of ModelRouting, and the engine reads the route for the
 * mode it is running, so this is the only place a mode's model is decided.
 */
export function setModelRoute(
  settings: SettingsStore,
  mode: ResearchMode,
  route: { primary: { providerId: string; model: string }; fallback: { providerId: string; model: string }[] },
): void {
  settings.modelRouting[mode] = {
    primary: { ...route.primary },
    fallback: route.fallback.map((ref) => ({ ...ref })),
  };
}

export function upsertSearch(settings: SettingsStore, id: string, patch: Partial<SearchProviderState>): SearchProviderState {
  const existing = settings.searchProviders[id];
  const next: SearchProviderState = {
    keys: existing?.keys ?? [],
    ...(existing?.url ? { url: existing.url } : {}),
    ...(existing?.zone ? { zone: existing.zone } : {}),
    ...patch,
  };
  settings.searchProviders[id] = next;
  if (!searchOrder(settings).includes(id)) setSearchOrder(settings, [...searchOrder(settings), id]);
  return next;
}

export function removeSearch(settings: SettingsStore, id: string): boolean {
  if (!(id in settings.searchProviders)) return false;
  delete settings.searchProviders[id];
  setSearchOrder(settings, settings.searchProviderOrder);
  return true;
}

export function addSearchKey(settings: SettingsStore, id: string, key: string): boolean {
  const trimmed = key.trim();
  const backend = settings.searchProviders[id];
  if (!backend || trimmed.length === 0) return false;
  if (backend.keys.includes(trimmed)) return false;
  backend.keys.push(trimmed);
  return true;
}

export function removeSearchKey(settings: SettingsStore, id: string, key: string): boolean {
  const backend = settings.searchProviders[id];
  if (!backend) return false;
  const index = backend.keys.indexOf(key);
  if (index < 0) return false;
  backend.keys.splice(index, 1);
  return true;
}

export interface ReadinessReport {
  ready: boolean;
  problems: string[];
  hints: string[];
}

/**
 * What still stands between this configuration and a working server. Shared by
 * `config` and `setup` so both give the same advice.
 */
export function readiness(settings: SettingsStore): ReadinessReport {
  const problems: string[] = [];
  const hints: string[] = [];

  const providers = readyProviderIds(settings);
  if (providers.length === 0) {
    problems.push('No LLM provider is enabled with an API key.');
  }
  const searches = readySearchIds(settings);
  if (searches.length === 0) {
    problems.push('No search backend has an API key.');
    hints.push('Search and research answer 503 until at least one backend has a key.');
  }
  return { ready: problems.length === 0, problems, hints };
}