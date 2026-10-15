/**
 * Typed client for the Athena v1 API. Every admin call carries the admin key;
 * every other call carries the bearer key. Same-origin by construction, so no
 * CORS configuration is involved.
 */

import { getAdminKey, getApiKey } from './storage';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; retryable?: boolean; details?: unknown };
}

async function request<T>(path: string, init: RequestInit = {}, admin = false): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');

  if (admin) {
    const key = getAdminKey();
    if (key) headers.set('X-Admin-Key', key);
  } else {
    const key = getApiKey();
    if (key) headers.set('Authorization', `Bearer ${key}`);
  }

  const response = await fetch(`/v1${path}`, { ...init, headers });
  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as ErrorBody & T | null;
  if (!response.ok) {
    const body = (payload ?? {}) as ErrorBody;
    throw new ApiError(
      body.error?.code ?? 'UNKNOWN',
      body.error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      body.error?.retryable ?? response.status >= 500,
      body.error?.details,
    );
  }
  return payload as T;
}

/* ── Search ─────────────────────────────────────────────────────────────── */

export interface SearchInput {
  query: string;
  type?: 'search' | 'news' | 'images' | 'videos' | 'places' | 'shopping' | 'scholar' | 'patents';
  count?: number;
  country?: string;
  language?: string;
  time_range?: 'day' | 'week' | 'month' | 'year' | null;
  depth?: 'links' | 'passages' | 'full';
  include_domains?: string[];
  exclude_domains?: string[];
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string | null;
  date: string | null;
}

export interface SearchResponse {
  query: string;
  query_used: string;
  type: string;
  results: SearchResultItem[];
  applied: { country: string; language: string; time_range: string | null; depth: string };
  metadata: { provider: string; count: number; elapsed_ms: number };
}

export const search = (input: SearchInput) =>
  request<SearchResponse>('/search', { method: 'POST', body: JSON.stringify(input) });

/* ── Contents ───────────────────────────────────────────────────────────── */

export interface ContentsResponse {
  documents: Array<{ url: string; title: string; content: string; content_digest: string }>;
  failed: Array<{ url: string; error: string }>;
}

export const contents = (urls: string[]) =>
  request<ContentsResponse>('/contents', { method: 'POST', body: JSON.stringify({ urls }) });

/* ── Research ───────────────────────────────────────────────────────────── */

export interface ResearchInput {
  query: string;
  mode?: 'instant' | 'default' | 'deep' | 'max';
  response_length?: 'short' | 'long' | 'exhaustive';
  verbosity?: 'summary' | 'detailed';
}

export interface ResearchAccepted {
  job_id: string;
  status: string;
  mode: string;
  reasoning_effort: string;
  response_length: string;
  verbosity: string;
  streams: { snapshot: string; events: string };
}

export const startResearch = (input: ResearchInput) =>
  request<ResearchAccepted>('/research', { method: 'POST', body: JSON.stringify(input) });

export type JobStatus =
  | 'queued' | 'planning' | 'searching' | 'reviewing' | 'synthesizing' | 'running'
  | 'completed' | 'failed' | 'cancelled' | 'paused' | 'declined';

export interface JobProgress {
  round: number | null;
  used_search_calls: number;
  search_calls_limit: number;
  used_fetch_calls: number;
  fetch_calls_limit: number;
  used_turns: number | null;
  used_tokens: number;
  token_limit: number;
  cost_usd: number | null;
  elapsed_ms: number | null;
}

export interface PublicJob {
  job_id: string;
  query: string;
  mode: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: JobProgress;
  progress_notes: Array<{ headline: string; body: string; at: string | null }>;
  result: { answer: string; sources: Array<{ index: number; title: string | null; url: string }> } | null;
  note: { headline: string; body: string; round?: number } | undefined;
  error: string | undefined;
}

export const getJob = (jobId: string) => request<PublicJob>(`/jobs/${jobId}`);

export const listJobs = (limit = 25) =>
  request<{ jobs: PublicJob[] }>(`/jobs?limit=${limit}`);

export const cancelJob = (jobId: string) =>
  request<PublicJob>(`/jobs/${jobId}/cancel`, { method: 'POST' });

export const pauseJob = (jobId: string) =>
  request<PublicJob>(`/jobs/${jobId}/pause`, { method: 'POST' });

export const resumeJob = (jobId: string) =>
  request<PublicJob>(`/jobs/${jobId}/resume`, { method: 'POST' });

/* ── Analytics & models ─────────────────────────────────────────────────── */

export interface AnalyticsRollup {
  window_days: number;
  generated_at: string;
  requests: number;
  errors: number;
  averageDurationMs: number;
  byDay: Array<{ day: string; requests: number; errors: number }>;
  byRoute: Array<{ route: string; requests: number; errors: number }>;
  byKey: Array<{ id: string; name: string; prefix: string; requests: number; errors: number }>;
}

export const analytics = (days = 7) =>
  request<AnalyticsRollup>(`/analytics?days=${days}`, {}, true);

export interface CatalogModel {
  id: string;
  name?: string;
  reasoning: boolean;
  tool_call: boolean;
  structured_output: boolean;
  attachment: boolean;
  context: number | null;
  max_output: number | null;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  release_date?: string;
  last_updated?: string;
  /** Whether this deployment serves the model. */
  configured: boolean;
  /** Modes whose primary route points here, so "default" can be set per row. */
  default_modes: string[];
}

export interface CatalogProvider {
  id: string;
  name?: string;
  npm?: string;
  api?: string;
  doc?: string;
  enabled: boolean;
  /** An empty whitelist means the whole catalog, which is what this reports. */
  serves_whole_catalog: boolean;
  configured_models: string[];
  catalog_count: number;
  models: CatalogModel[];
}

/** Admin-gated: the console reads it behind the operator key. */
export const models = (provider?: string) =>
  request<{ source: string; fetched_at: string; providers: CatalogProvider[] }>(
    `/models${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`,
    {},
    true,
  );

/* ── Keys (admin) ───────────────────────────────────────────────────────── */

export interface PublicApiKey {
  id: string;
  name: string;
  plan: 'free' | 'paid' | 'enterprise';
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const listKeys = () => request<{ keys: PublicApiKey[] }>('/keys', {}, true);

export const createKey = (name: string, plan: 'free' | 'paid' | 'enterprise') =>
  request<{ key: PublicApiKey; secret: string }>('/keys', {
    method: 'POST',
    body: JSON.stringify({ name, plan }),
  }, true);

export const revokeKey = (id: string) =>
  request<{ revoked: boolean }>(`/keys/${id}`, { method: 'DELETE' }, true);

/* ── Settings (admin) ───────────────────────────────────────────────────── */

/**
 * The settings document as the console sees it: the stored `settings.yaml`,
 * camelCase and all, with every secret replaced by its mask. Send a mask back
 * to keep the secret it came from; send a new value to replace it.
 */
export interface SettingsProviderState {
  enabled: boolean;
  /** Masked: `…1234`. Never the stored secret. */
  keys: string[];
  keyCount: number;
  /** Empty `models` means the whole catalog is served. */
  servesWholeCatalog: boolean;
  models: string[];
  anonymous?: boolean;
  url?: string;
  name?: string;
  npm?: string;
  env?: string[];
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  includeThoughts?: boolean;
  disabledThinkingModels?: string[];
  inlineToolCallModels?: string[];
  modelPrices?: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
}

export interface SettingsSearchProviderState {
  keys: string[];
  keyCount: number;
  url?: string;
  zone?: string;
  keyless?: boolean;
}

export interface ModelReference {
  providerId: string;
  model: string;
}

export interface ModelRoute {
  primary: ModelReference;
  fallback: ModelReference[];
}

export type ResearchModeId = 'instant' | 'default' | 'deep' | 'max';

export interface OperatorSettings {
  providers: Record<string, SettingsProviderState>;
  providerOrder: string[];
  searchProviders: Record<string, SettingsSearchProviderState>;
  searchProviderOrder: string[];
  modelRouting: Record<ResearchModeId, ModelRoute>;
  api: {
    defaultMaxConcurrent: number;
    maxActiveJobs: number;
    maxActiveBatches: number;
    maxEventsPerJob: number;
    maxEventsPerBatch: number;
    maxRetentionMinutes: number;
    defaultMode: 'default' | 'deep' | 'max';
  };
  general: {
    /** Results per search when the caller does not name a count. */
    maxSources: number;
  };
  modes: ResearchModeId[];
  /** Read-only: both take effect when the server binds its socket. */
  server: { port: number; host: string };
  catalog: {
    providers: Array<{ id: string; name: string; npm: string; api: string; modelCount: number; configured: boolean; enabled: boolean }>;
    /** Runtime packages this build can run, for the provider form's picker. */
    runtimePackages: string[];
    search: Array<{ id: string; name: string; needsZone: boolean; keyless: boolean }>;
  };
  readiness: { ready: boolean; problems: string[]; hints: string[] };
}

/**
 * Fields a section-level change may carry. Everything is optional, so the
 * console can send just the section it edited; `null` removes a provider or a
 * search backend.
 */
export interface SettingsPatch {
  providers?: Record<string, SettingsProviderState | null>;
  providerOrder?: string[];
  searchProviders?: Record<string, SettingsSearchProviderState | null>;
  searchProviderOrder?: string[];
  modelRouting?: Partial<Record<ResearchModeId, { primary?: ModelReference; fallback?: ModelReference[] }>>;
  api?: Partial<OperatorSettings['api']>;
  general?: Partial<OperatorSettings['general']>;
}

export const getSettings = () => request<OperatorSettings>('/settings', {}, true);

export const updateSettings = (patch: SettingsPatch) =>
  request<OperatorSettings>('/settings', { method: 'PUT', body: JSON.stringify(patch) }, true);
