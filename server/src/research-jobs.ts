import { randomBytes } from 'crypto';
import type { AgentStep, SearchResponse, Source } from './schemas.js';
import type { ReasoningEffort, ResearchMode, ResearchVerbosity, ResearchPreset, ResponseLength } from './engine/modes.js';
import { loadResearchCheckpoint, saveResearchCheckpoint, type ResearchCheckpoint } from './engine/checkpoint.js';
import { deleteEvidence } from './engine/evidence-store.js';
import { assertResearchMode, DEFAULT_RESEARCH_MODE, DEFAULT_RESEARCH_VERBOSITY, DEFAULT_RESPONSE_LENGTH, reasoningEffortForMode } from './engine/modes.js';
import {
  deletePersistedResearchJob,
  loadRecentResearchJobs,
  loadResearchJobEvents,
  pruneResearchJobEvents,
  purgePersistedResearchJob,
  saveResearchJobSnapshot,
  saveResearchJobWithEvent,
} from './research-job-store.js';

export type ResearchJobStatus = 'queued' | 'planning' | 'searching' | 'reviewing' | 'synthesizing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'declined';

export interface ResearchJobRuntime {
  budget: import('./engine/modes.js').BudgetState;
  round: number;
  sourceMap?: import('./engine/types.js').SourceWithIndex[];
}

export interface ResearchJobRequest {
  query: string;
  history?: { role: string; content: string }[];
  mode?: ResearchMode;
  conversationId?: string;
  preset?: ResearchPreset;
  reasoningEffort?: ReasoningEffort;
  responseLength?: ResponseLength;
  verbosity?: ResearchVerbosity;
  researchApi?: boolean;
  /** Public id of the key that paid for this job; used to bill it on completion. */
  apiKeyId?: string;
}

export type ResearchJobEvent = (
  | { type: 'status'; status: ResearchJobStatus; detail?: string; timestamp: string }
  | { type: 'step'; data: AgentStep; timestamp: string }
  | { type: 'progress'; data: import('./engine/types.js').ResearchProgressState; timestamp: string }
  /* A note the model published with report_progress. Carries the note itself,
     not the runtime state above: the two share nothing but the need to reach
     the consumer while the job runs. */
  | { type: 'progress_note'; data: { headline: string; body: string; round?: number }; timestamp: string }
  | { type: 'token'; text: string; timestamp: string }
  | { type: 'sources'; sources: Source[]; timestamp: string }
  | { type: 'context'; finalContext: string; timestamp: string }
  | { type: 'done'; response: SearchResponse; timestamp: string }
  | { type: 'error'; message: string; finalContext?: string; timestamp: string }
) & { seq?: number };

export interface ResearchJobRecord {
  id: string;
  query: string;
  history?: { role: string; content: string }[];
  mode: ResearchMode;
  preset?: ResearchPreset;
  /** Derived from `mode` on creation; kept so the response can report it. */
  reasoningEffort?: ReasoningEffort;
  responseLength?: ResponseLength;
  verbosity?: ResearchVerbosity;
  researchApi?: boolean;
  apiKeyId?: string;
  tokensReported?: boolean;
  status: ResearchJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  cancelled: boolean;
  /** When the job was paused. A paused job that ages past the TTL is cancelled. */
  pausedAt?: string;
  steps?: AgentStep[];
  /** Latest status note the model published; also served on the job snapshot. */
  note?: { headline: string; body: string; round?: number };
  result?: SearchResponse;
  finalContext?: string;
  events: ResearchJobEvent[];
  lastEventSeq?: number;
  controller?: AbortController;
  conversationId?: string;
  runtime?: ResearchJobRuntime;
}

const jobs = new Map<string, ResearchJobRecord>();
const listeners = new Map<string, Set<(job: ResearchJobRecord) => void>>();
export let MAX_EVENTS = 250;
export let MAX_JOBS = 50;

export function applyAPISettings(opts: { maxActiveJobs?: number; maxEventsPerJob?: number }) {
  if (opts.maxActiveJobs !== undefined) MAX_JOBS = Math.max(1, opts.maxActiveJobs);
  if (opts.maxEventsPerJob !== undefined) MAX_EVENTS = Math.max(10, opts.maxEventsPerJob);
  for (const job of jobs.values()) {
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    const firstSeq = job.events[0]?.seq;
    if (typeof firstSeq === 'number') pruneResearchJobEvents(job.id, firstSeq);
    persistJob(job);
  }
  trimJobs();
}

function persistJob(job: ResearchJobRecord): void {
  const { events: _events, controller: _controller, ...stored } = job;
  void _events;
  void _controller;
  saveResearchJobSnapshot({
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    data: JSON.stringify(stored),
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const ordered = Array.from(jobs.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  while (ordered.length > MAX_JOBS) {
    const removed = ordered.shift();
    if (!removed) break;
    jobs.delete(removed.id);
    listeners.delete(removed.id);
    deletePersistedResearchJob(removed.id);
  }
}

function notify(id: string) {
  const job = jobs.get(id);
  if (!job) return;
  const subs = listeners.get(id);
  if (!subs) return;
  for (const fn of subs) {
    try {
      fn(job);
    } catch {
      // Listener errors must not affect job execution.
    }
  }
}

function pushEvent(job: ResearchJobRecord, event: ResearchJobEvent) {
  const seq = (job.lastEventSeq ?? 0) + 1;
  job.lastEventSeq = seq;
  job.events.push({ ...event, seq });
  /* The snapshot carries the latest note so a poller sees it without reading
     the event stream. */
  if (event.type === 'progress_note') job.note = { ...event.data };
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
  job.updatedAt = nowIso();
  const { events: _events, controller: _controller, ...stored } = job;
  void _events;
  void _controller;
  saveResearchJobWithEvent({
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
    data: JSON.stringify(stored),
  }, {
    seq,
    at: event.timestamp ?? job.updatedAt,
    data: JSON.stringify({ ...event, seq }),
  }, job.events[0]?.seq ?? seq);
}

const JOB_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** New job id, e.g. j-4Kx9Q2mzA8vB. Exported so tests and tooling use the same shape. */
export function newJobId(): string {
  const bytes = randomBytes(12);
  let id = 'j-';
  for (const byte of bytes) id += JOB_ID_ALPHABET[byte % JOB_ID_ALPHABET.length];
  return id;
}

export function createResearchJob(req: ResearchJobRequest): ResearchJobRecord {
  /* Short readable ids: j- plus 12 base62 characters (~71 bits). Collision-checked
     against live jobs; 12 chars keeps URLs, filenames and console output short. */
  let id = newJobId();
  while (jobs.has(id)) id = newJobId();
  const job: ResearchJobRecord = {
    id,
    query: req.query,
    history: req.history,
    mode: req.mode ?? DEFAULT_RESEARCH_MODE,
    preset: req.preset,
    reasoningEffort: reasoningEffortForMode(req.mode ?? DEFAULT_RESEARCH_MODE),
    responseLength: req.responseLength ?? DEFAULT_RESPONSE_LENGTH,
    verbosity: req.verbosity ?? DEFAULT_RESEARCH_VERBOSITY,
    researchApi: req.researchApi,
    apiKeyId: req.apiKeyId ?? undefined,
    status: 'queued',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    cancelled: false,
    steps: [],
    events: [],
    lastEventSeq: 0,
    conversationId: req.conversationId,
  };
  jobs.set(id, job);
  pushEvent(job, { type: 'status', status: 'queued', timestamp: nowIso() });
  trimJobs();
  return job;
}

export function getResearchJob(id: string): ResearchJobRecord | undefined {
  return jobs.get(id);
}

export function listResearchJobs(): ResearchJobRecord[] {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function markResearchJobRunning(id: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.cancelled || job.status === 'completed' || job.status === 'failed' || job.status === 'declined') return undefined;
  job.status = 'running';
  job.startedAt = job.startedAt || nowIso();
  pushEvent(job, { type: 'status', status: 'running', timestamp: nowIso() });
  notify(id);
  return job;
}

export function attachResearchJobController(id: string, controller: AbortController): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.controller = controller;
  return job;
}

export function markResearchJobDone(id: string, result: SearchResponse): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.status = 'completed';
  job.result = result;
  job.finishedAt = nowIso();
  /* Written before the event, so a client that reconnects after seeing `done`
     already reads a completed snapshot. Without this a finished job stayed at
     whatever the last running snapshot said, which is why the token totals in
     `cli stats` only ever reflected paused jobs. */
  persistJob(job);
  pushEvent(job, { type: 'done', response: result, timestamp: nowIso() });
  notify(id);
  /* The run is over, so its evidence directory goes with it. The trace holds
     the full conversation; the store has no post-mortem readers. */
  deleteEvidence(id);
  return job;
}

export function markResearchJobFailed(id: string, message: string, finalContext?: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.status = job.cancelled ? 'cancelled' : 'failed';
  job.error = message;
  if (finalContext !== undefined) job.finalContext = finalContext;
  job.finishedAt = nowIso();
  /* A failed run spent real tokens too. Its cost has to be in the totals, or a
     provider that fails repeatedly looks free. */
  persistJob(job);
  pushEvent(job, { type: 'error', message, finalContext, timestamp: nowIso() });
  notify(id);
  deleteEvidence(id);
  return job;
}

export function setResearchJobStatus(id: string, status: ResearchJobStatus, detail?: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.cancelled || job.status === 'completed' || job.status === 'failed' || job.status === 'declined') return job;
  if (job.status === 'paused') return job;
  job.status = status;
  pushEvent(job, { type: 'status', status, detail, timestamp: nowIso() });
  notify(id);
  return job;
}

export function setResearchJobFinalContext(id: string, finalContext: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.finalContext = finalContext;
  job.updatedAt = nowIso();
  persistJob(job);
  return job;
}

export function setResearchJobRuntime(id: string, runtime: ResearchJobRuntime): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.runtime = runtime;
  job.updatedAt = nowIso();
  persistJob(job);
  return job;
}

export function pauseResearchJob(id: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.status !== 'running' && job.status !== 'planning' && job.status !== 'searching' && job.status !== 'reviewing' && job.status !== 'synthesizing') {
    return undefined;
  }

  job.status = 'paused';
  job.pausedAt = nowIso();
  job.updatedAt = nowIso();

  if (job.preset && job.runtime?.budget) {
    const existing = loadResearchCheckpoint(id);
    saveResearchCheckpoint({
      jobId: id,
      query: job.query,
      preset: job.preset,
      budget: job.runtime.budget,
      round: job.runtime.round,
      sourceMap: job.runtime.sourceMap ?? existing?.sourceMap ?? [],
      lastUpdatedAt: nowIso(),
    });
  }

  job.controller?.abort();
  pushEvent(job, { type: 'status', status: 'paused', detail: 'Paused by user', timestamp: nowIso() });
  notify(id);
  return job;
}

export function resumeResearchJob(id: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job || job.status !== 'paused') return undefined;
  job.status = 'queued';
  job.cancelled = false;
  job.error = undefined;
  job.finishedAt = undefined;
  job.pausedAt = undefined;
  pushEvent(job, { type: 'status', status: 'queued', detail: 'Resuming from checkpoint', timestamp: nowIso() });
  notify(id);
  return job;
}

export function registerRecoveredJob(checkpoint: ResearchCheckpoint): ResearchJobRecord {
  const existing = jobs.get(checkpoint.jobId);
  if (existing) return existing;

  const job: ResearchJobRecord = {
    id: checkpoint.jobId,
    query: checkpoint.query,
    mode: checkpoint.preset.mode,
    preset: checkpoint.preset,
    reasoningEffort: checkpoint.reasoningEffort,
    verbosity: checkpoint.verbosity,
    researchApi: checkpoint.researchApi,
    status: 'paused',
    createdAt: checkpoint.lastUpdatedAt,
    updatedAt: nowIso(),
    cancelled: false,
    /* The clock restarts here: killing a recovered job for time that passed
       while the server was down would punish the operator for restarting. */
    pausedAt: nowIso(),
    steps: [],
    events: [],
    lastEventSeq: 0,
    runtime: {
      budget: checkpoint.budget,
      round: checkpoint.round,
      sourceMap: checkpoint.sourceMap,
    },
  };
  jobs.set(checkpoint.jobId, job);
  pushEvent(job, { type: 'status', status: 'paused', detail: 'Recovered after server restart. Resume this job explicitly to continue.', timestamp: nowIso() });
  trimJobs();
  return job;
}

/**
 * Cancels paused jobs that aged past the TTL. A paused job holds a
 * checkpoint and an evidence directory but does no work; without this the
 * paused list is a graveyard that only grows. Cancelled jobs keep their
 * record, so the audit trail survives. Returns the cancelled ids.
 */
export function cancelStalePausedJobs(ttlMs: number, nowMs: number = Date.now()): string[] {
  const cancelled: string[] = [];
  for (const job of jobs.values()) {
    if (job.status !== 'paused') continue;
    const pausedAt = job.pausedAt ? Date.parse(job.pausedAt) : Number.NaN;
    /* No stamp (written by an older build): fall back to the last update so
       it still expires instead of living forever. */
    const ageMs = nowMs - (Number.isFinite(pausedAt) ? pausedAt : Date.parse(job.updatedAt));
    if (!Number.isFinite(ageMs) || ageMs <= ttlMs) continue;
    cancelResearchJob(job.id, `Paused too long (over ${Math.round(ttlMs / 60000)}m); cancelled automatically`);
    cancelled.push(job.id);
  }
  return cancelled;
}

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'declined']);

/** Drops one job from memory and SQLite (rows and events). Returns true when it existed. */
export function removeJobRecord(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  jobs.delete(id);
  listeners.delete(id);
  purgePersistedResearchJob(id);
  return true;
}

/**
 * Drops terminal jobs older than the retention window, from memory and from
 * SQLite (rows and events). Running and paused jobs are never touched no
 * matter their age; the paused TTL owns those. Returns the purged ids.
 */
export function purgeOldJobs(retentionMs: number, nowMs: number = Date.now()): string[] {
  const purged: string[] = [];
  for (const job of jobs.values()) {
    if (!TERMINAL_JOB_STATUSES.has(job.status)) continue;
    const updatedAt = Date.parse(job.updatedAt);
    if (!Number.isFinite(updatedAt) || nowMs - updatedAt <= retentionMs) continue;
    if (removeJobRecord(job.id)) purged.push(job.id);
  }
  return purged;
}

/**
 * Ends a job the model declined to research. Terminal like a cancellation:
 * the slot is released and work done so far is billed. The reason travels on
 * the status event, so declines stay countable in stats and traces.
 */
export function markResearchJobDeclined(id: string, reason: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.status = 'declined';
  job.finishedAt = nowIso();
  pushEvent(job, { type: 'status', status: 'declined', timestamp: nowIso(), detail: reason });
  notify(id);
  /* Nothing to resume from: a declined run never restarts. */
  deleteEvidence(id);
  return job;
}

export function cancelResearchJob(id: string, detail = 'Cancelled by user'): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.cancelled = true;
  job.controller?.abort();
  job.status = 'cancelled';
  job.finishedAt = nowIso();
  pushEvent(job, { type: 'status', status: 'cancelled', timestamp: nowIso(), detail });
  notify(id);
  /* A cancelled run never resumes, so its evidence goes now. A paused run
     keeps its store: resume reuses the same job id. */
  deleteEvidence(id);
  return job;
}

export function appendResearchJobEvent(id: string, event: ResearchJobEvent): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.cancelled && event.type !== 'status') return job;
  if (job.status === 'paused' && event.type !== 'status') return job;
  if (event.type === 'step') {
    job.steps!.push(event.data);
  }
  if (event.type === 'error' && job.cancelled) {
    pushEvent(job, { type: 'status', status: 'cancelled', timestamp: nowIso(), detail: 'Cancelled' });
  }
  pushEvent(job, event);
  notify(id);
  return job;
}

export function subscribeResearchJob(id: string, listener: (job: ResearchJobRecord) => void): () => void {
  const subs = listeners.get(id) || new Set<(job: ResearchJobRecord) => void>();
  subs.add(listener);
  listeners.set(id, subs);
  return () => {
    const current = listeners.get(id);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(id);
  };
}

function restorePersistedJobs(): void {
  const active = new Set<ResearchJobStatus>(['queued', 'planning', 'searching', 'reviewing', 'synthesizing', 'running']);
  for (const row of loadRecentResearchJobs(MAX_JOBS)) {
    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      const events = loadResearchJobEvents(row.id, MAX_EVENTS).map((event) => JSON.parse(event) as ResearchJobEvent);
      const job = {
        ...data,
        id: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        status: row.status as ResearchJobStatus,
        events,
        controller: undefined,
      } as unknown as ResearchJobRecord;
      const lastSeq = events.reduce((max, event) => Math.max(max, event.seq ?? 0), job.lastEventSeq ?? 0);
      job.lastEventSeq = lastSeq;
      /* The mode comes out of a JSON column rather than a request body, so it is
         validated here. A bad value throws instead of quietly resolving the
         ceilings of a different mode. */
      job.mode = assertResearchMode(job.mode);
      /* Effort is derived from the mode, so a row written by an older build
         cannot leave the job thinking at a level its mode never allowed. */
      job.reasoningEffort = reasoningEffortForMode(job.mode);
      /* A job stored before per-model usage was tracked resumes with an empty
         ledger, so a restored job is never billed for unreported tokens. */
      if (job.runtime?.budget) job.runtime.budget.tokenLedger ??= {};

      if (active.has(job.status)) {
        const checkpoint = loadResearchCheckpoint(job.id);
        job.cancelled = false;
        job.error = undefined;
        if (checkpoint) {
          job.status = 'paused';
          job.finishedAt = undefined;
          job.runtime ??= {
            budget: checkpoint.budget,
            round: checkpoint.round,
            sourceMap: checkpoint.sourceMap,
          };
          jobs.set(job.id, job);
          pushEvent(job, { type: 'status', status: 'paused', detail: 'Paused after server restart. Resume this job explicitly to continue.', timestamp: nowIso() });
        } else {
          job.status = 'failed';
          job.finishedAt = nowIso();
          job.error = 'The service restarted before this job completed; no checkpoint was available.';
          jobs.set(job.id, job);
          pushEvent(job, { type: 'status', status: 'failed', detail: job.error, timestamp: nowIso() });
        }
      } else {
        jobs.set(job.id, job);
      }
    } catch (error) {
      console.error('[research-job-store] skipped an unreadable stored job:', error instanceof Error ? error.message : String(error));
    }
  }
  trimJobs();
}

restorePersistedJobs();
