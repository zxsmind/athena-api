import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getDataPath } from './storage.js';
import { loadSettings } from './settings-store.js';

export interface ModelsDevModelCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  attachment?: boolean;
  limit?: { context?: number; output?: number };
  /** Prices are US dollars per one million tokens. */
  cost?: ModelsDevModelCost;
  release_date?: string;
  last_updated?: string;
  [key: string]: unknown;
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  npm?: string;
  api?: string;
  doc?: string;
  env?: string[];
  models?: Record<string, ModelsDevModel>;
  [key: string]: unknown;
}

export interface ModelsDevSnapshot {
  fetchedAt: string;
  providers: Record<string, ModelsDevProvider>;
}

const CACHE_FILE = getDataPath('models.dev-cache.json');
const CATALOG_URL = 'https://models.dev/api.json';
/** Default refresh cadence. Overridable via `config.catalog.refreshIntervalHours`. */
export const DEFAULT_CATALOG_REFRESH_MS = 12 * 60 * 60 * 1000;
/** Backoff after a failed refresh when there is nothing cached to serve. */
export const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/** A refresh is due once the cache is older than this. */
function isFresh(value: ModelsDevSnapshot, ttlMs: number): boolean {
  const fetchedAt = Date.parse(value.fetchedAt);
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < ttlMs;
}

let snapshot: ModelsDevSnapshot | null = null;
let inFlight: Promise<ModelsDevSnapshot> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSnapshot(value: unknown): ModelsDevSnapshot | null {
  if (!isRecord(value)) return null;
  const rawProviders = isRecord(value.providers) ? value.providers : value;
  const providers: Record<string, ModelsDevProvider> = {};
  for (const [id, candidate] of Object.entries(rawProviders)) {
    if (!isRecord(candidate)) continue;
    const rawModels = isRecord(candidate.models) ? candidate.models : {};
    const models: Record<string, ModelsDevModel> = {};
    for (const [modelId, model] of Object.entries(rawModels)) {
      if (!isRecord(model)) continue;
      models[modelId] = { id: modelId, ...model } as ModelsDevModel;
    }
    providers[id] = { id, ...candidate, models } as ModelsDevProvider;
  }
  if (Object.keys(providers).length === 0) return null;
  return {
    fetchedAt: typeof value.fetchedAt === 'string' ? value.fetchedAt : '',
    providers,
  };
}

function readDiskSnapshot(): ModelsDevSnapshot | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return normalizeSnapshot(JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

function currentSnapshot(): ModelsDevSnapshot | null {
  if (snapshot) return snapshot;
  snapshot = readDiskSnapshot();
  return snapshot;
}

export interface CatalogRefreshOptions {
  /** Cadence. Defaults to {@link DEFAULT_CATALOG_REFRESH_MS}. */
  intervalMs?: number;
  /**
   * Delay before retrying after a failure when nothing usable is cached.
   * Prevents a hot loop while models.dev is unreachable. Defaults to
   * {@link DEFAULT_RETRY_DELAY_MS}.
   */
  retryDelayMs?: number;
  /** Called on every outcome. Used for logging. */
  onEvent?: (event: CatalogRefreshEvent) => void;
  /** Injectable for tests. */
  now?: () => number;
  /** Injectable for tests; defaults to {@link getModelsDevSnapshot}. */
  fetchCatalog?: (options: { refresh?: boolean }) => Promise<ModelsDevSnapshot>;
}

export type CatalogRefreshEvent =
  | { type: 'scheduled'; delayMs: number; at: string }
  | { type: 'refreshed'; providers: number }
  | { type: 'skipped'; reason: string }
  | { type: 'failed'; reason: string };

export interface CatalogRefreshState {
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextRefreshAt: string | null;
}

const refreshState: CatalogRefreshState = {
  running: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  nextRefreshAt: null,
};

export function getCatalogRefreshState(): CatalogRefreshState {
  return { ...refreshState };
}

/**
 * Milliseconds until the cache needs refreshing, or 0 when there is nothing
 * usable cached.
 *
 * A timestamp in the future means the cache is not trustworthy — a skewed
 * clock, a copied file, a manual edit — so it yields 0 and forces a refresh
 * rather than waiting out the full interval.
 */
export function catalogRefreshDelayMs(snapshot: ModelsDevSnapshot | null, intervalMs: number, nowMs: number): number {
  if (!snapshot) return 0;
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt > nowMs) return 0;
  return Math.max(0, fetchedAt + intervalMs - nowMs);
}

/**
 * Keeps the catalog fresh on a fixed cadence.
 *
 * A plain interval would refresh between 12 and 24 hours after the last fetch,
 * because the phase is anchored to process start. This instead schedules one
 * timeout for the exact moment the cache expires and re-arms after each fetch,
 * so the cadence stays 12 hours regardless of uptime.
 *
 * Fire and forget: the refresh never blocks a request, never throws into the
 * caller, and keeps serving the previous snapshot when models.dev is
 * unreachable. The timer is unref'd so it can never hold the process open.
 */
export function startCatalogRefresh(options: CatalogRefreshOptions = {}): () => void {
  const intervalMs = options.intervalMs && options.intervalMs > 0 ? options.intervalMs : DEFAULT_CATALOG_REFRESH_MS;
  const now = options.now ?? Date.now;
  const fetchCatalog = options.fetchCatalog ?? getModelsDevSnapshot;
  const emit = options.onEvent ?? (() => {});

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  /**
   * Arms one timeout for the moment the given snapshot expires. The snapshot it
   * re-arms from is the one just fetched, never the module cache, so the
   * cadence cannot collapse to zero when a caller supplies its own fetcher.
   */
  const arm = (basis: ModelsDevSnapshot | null, overrideDelayMs?: number): void => {
    if (stopped) return;
    const delayMs = overrideDelayMs ?? catalogRefreshDelayMs(basis, intervalMs, now());
    refreshState.nextRefreshAt = new Date(now() + delayMs).toISOString();
    emit({ type: 'scheduled', delayMs, at: refreshState.nextRefreshAt });
    timer = setTimeout(run, delayMs);
    /* Never keep the process alive just to refresh a cache. */
    timer.unref?.();
  };

  const run = async (): Promise<void> => {
    if (stopped) return;
    refreshState.lastAttemptAt = new Date(now()).toISOString();
    try {
      const next = await fetchCatalog({ refresh: true });
      refreshState.lastSuccessAt = new Date(now()).toISOString();
      refreshState.lastError = null;
      emit({ type: 'refreshed', providers: Object.keys(next.providers).length });
      arm(next);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      refreshState.lastError = reason;
      emit({ type: 'failed', reason });
      /* Keep serving whatever is cached. With no usable snapshot the computed
         delay would be zero, so back off explicitly rather than spinning while
         models.dev is unreachable. */
      const cached = currentSnapshot();
      if (cached) arm(cached);
      else arm(null, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    }
  };

  arm(currentSnapshot());
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    refreshState.running = false;
    refreshState.nextRefreshAt = null;
  };
}

/** Resets refresh bookkeeping. Exported for tests. */
export function resetCatalogRefreshStateForTests(): void {
  refreshState.running = false;
  refreshState.lastAttemptAt = null;
  refreshState.lastSuccessAt = null;
  refreshState.lastError = null;
  refreshState.nextRefreshAt = null;
}

export function getCachedModelsDevProvider(providerId: string): ModelsDevProvider | null {
  return currentSnapshot()?.providers[providerId] ?? null;
}

/** Ids of every provider in the cached catalog. Empty when nothing is cached. */
export function listCachedModelsDevProviderIds(): string[] {
  return Object.keys(currentSnapshot()?.providers ?? {});
}

export function getCachedModelsDevModel(providerId: string, modelId: string): ModelsDevModel | null {
  const provider = getCachedModelsDevProvider(providerId);
  return provider?.models?.[modelId] ?? null;
}

/**
 * Finds a model by id across every catalog provider.
 *
 * Local provider ids (a self-hosted endpoint, a proxy, a custom name like
 * "sovinfra") never match catalog provider ids, so a provider-scoped lookup
 * returns null for exactly the setups that need a window most. The model id is
 * the stable part: `qwen3.8-27b` is the same model wherever it is served.
 *
 * When providers disagree, the most common value wins: it is the model's
 * native capability, and outliers in either direction are one provider's
 * listing choice, not the model. A tie breaks toward the smaller window,
 * because over-triggering compaction is safe and overflowing is not. A
 * provider that caps below the native window is still protected by the
 * emergency overflow retry.
 */
export function findModelWindowAcrossProviders(modelId: string): number | null {
  const snapshot = currentSnapshot();
  if (!snapshot || !modelId) return null;
  const votes = new Map<number, number>();
  for (const provider of Object.values(snapshot.providers)) {
    const limit = provider.models?.[modelId]?.limit?.context;
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      votes.set(limit, (votes.get(limit) ?? 0) + 1);
    }
  }
  if (votes.size === 0) return null;
  let best: number | null = null;
  let bestVotes = -1;
  for (const [limit, count] of votes) {
    if (count > bestVotes || (count === bestVotes && (best === null || limit < best))) {
      best = limit;
      bestVotes = count;
    }
  }
  return best;
}

export interface ModelTokenPrice {
  /** US dollars per one million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Token price for a model, or null when the catalog has no price. A missing
 * price must never be substituted with a guess; callers surface it instead.
 */
export function getCachedModelTokenPrice(providerId: string, modelId: string): ModelTokenPrice | null {
  /* An operator price in settings.yaml wins over the catalog. A self-hosted or
     brand-new model has no catalog entry, and the alternative was reporting it
     as free. */
  const override = loadSettings().providers[providerId]?.modelPrices?.[modelId];
  if (override && [override.input, override.output, override.cacheRead, override.cacheWrite].some((v) => typeof v === 'number')) {
    return {
      /* Absent means "the operator did not say", not "free". A missing stream
         is still priced at zero for the total, but the report separates a model
         with no price from one priced at nothing, and the operator can see which
         of the three streams they actually supplied. */
      input: override.input ?? 0,
      output: override.output ?? 0,
      cacheRead: override.cacheRead ?? 0,
      cacheWrite: override.cacheWrite ?? 0,
    };
  }
  const cost = getCachedModelsDevModel(providerId, modelId)?.cost;
  if (!cost) return null;
  const hasAny = [cost.input, cost.output, cost.cache_read, cost.cache_write].some((value) => typeof value === 'number');
  if (!hasAny) return null;
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cache_read ?? 0,
    cacheWrite: cost.cache_write ?? 0,
  };
}

/** TTL used by the lazy path. Set once at startup from `config.catalog`. */
let catalogTtlMs = DEFAULT_CATALOG_REFRESH_MS;

export function setCatalogRefreshIntervalMs(intervalMs: number): void {
  if (Number.isFinite(intervalMs) && intervalMs > 0) catalogTtlMs = intervalMs;
}

export function getCatalogRefreshIntervalMs(): number {
  return catalogTtlMs;
}

/** Resolves the configured cadence. */
export function catalogIntervalMsFromHours(hours: number): number {
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : DEFAULT_CATALOG_REFRESH_MS;
}

/**
 * Returns the catalog, fetching it only when the cache is stale.
 *
 * `ttlMs` is injectable so tests can control freshness; production uses the
 * process-wide value from {@link setCatalogRefreshIntervalMs}.
 */
export async function getModelsDevSnapshot(
  options: { refresh?: boolean; ttlMs?: number } = {},
): Promise<ModelsDevSnapshot> {
  const cached = currentSnapshot();
  const ttlMs = options.ttlMs ?? catalogTtlMs;
  if (!options.refresh && cached && isFresh(cached, ttlMs)) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > 20 * 1024 * 1024) throw new Error('models.dev catalog exceeded the 20 MiB limit');
      const parsed = normalizeSnapshot(await response.json() as unknown);
      if (!parsed) throw new Error('models.dev returned an invalid provider catalog');
      const next = { ...parsed, fetchedAt: new Date().toISOString() };
      await mkdir(dirname(CACHE_FILE), { recursive: true });
      const tempFile = `${CACHE_FILE}.tmp`;
      await writeFile(tempFile, JSON.stringify(next), 'utf8');
      await rename(tempFile, CACHE_FILE);
      snapshot = next;
      return next;
    } catch (error) {
      if (cached) return cached;
      throw error;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function listConfiguredModelsDevProviders(providerIds: readonly string[]): ModelsDevProvider[] {
  const catalog = currentSnapshot()?.providers;
  if (!catalog) return [];
  return providerIds.flatMap((rawId) => {
    const provider = catalog[rawId];
    return provider ? [provider] : [];
  });
}
