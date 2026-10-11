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
}

export interface CatalogProvider {
  id: string;
  name?: string;
  npm?: string;
  api?: string;
  doc?: string;
  configured_models: string[];
  models: CatalogModel[];
}

export const models = (provider?: string) =>
  request<{ source: string; fetched_at: string; providers: CatalogProvider[] }>(
    `/models${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`,
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
