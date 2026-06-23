import { randomUUID } from 'crypto';
import type { AgentStep, SearchResponse, Source } from './schemas.js';
import type { DeepDepth, ResolvedResearchPreset } from './engine/depth-presets.js';
import { loadResearchCheckpoint, saveResearchCheckpoint, type ResearchCheckpoint } from './engine/checkpoint.js';

export type ResearchJobStatus = 'queued' | 'planning' | 'searching' | 'reviewing' | 'synthesizing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';

export interface ResearchJobRuntime {
  usedCredits: number;
  remainingCredits: number;
  round: number;
  notebookId?: string;
  notebookUpdates?: number;
  sourceMap?: import('./engine/types.js').SourceWithIndex[];
}

export interface ResearchJobRequest {
  query: string;
  history?: { role: string; content: string }[];
  mode?: 'quick' | 'deep';
  depth?: DeepDepth;
  conversationId?: string;
  preset?: ResolvedResearchPreset;
}

export type ResearchJobEvent =
  | { type: 'status'; status: ResearchJobStatus; detail?: string; timestamp: string }
  | { type: 'step'; data: AgentStep; timestamp: string }
  | { type: 'progress'; data: import('./engine/types.js').ResearchProgressState; timestamp: string }
  | { type: 'token'; text: string; timestamp: string }
  | { type: 'message_segment'; timestamp: string }
  | { type: 'sources'; sources: Source[]; timestamp: string }
  | { type: 'context'; finalContext: string; timestamp: string }
  | { type: 'done'; response: SearchResponse; timestamp: string }
  | { type: 'error'; message: string; finalContext?: string; timestamp: string };

export interface ResearchJobRecord {
  id: string;
  query: string;
  history?: { role: string; content: string }[];
  mode: 'quick' | 'deep';
  depth?: DeepDepth;
  preset?: ResolvedResearchPreset;
  status: ResearchJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  cancelled: boolean;
  steps?: AgentStep[];
  result?: SearchResponse;
  finalContext?: string;
  events: ResearchJobEvent[];
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
  job.events.push(event);
  if (job.events.length > MAX_EVENTS) {
    job.events.splice(0, job.events.length - MAX_EVENTS);
  }
  job.updatedAt = nowIso();
}

export function createResearchJob(req: ResearchJobRequest): ResearchJobRecord {
  const id = randomUUID();
  const job: ResearchJobRecord = {
    id,
    query: req.query,
    history: req.history,
    mode: req.mode || 'quick',
    depth: req.depth,
    preset: req.preset,
    status: 'queued',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    cancelled: false,
    steps: [],
    events: [],
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
  if (job.cancelled || job.status === 'completed' || job.status === 'failed') return undefined;
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
  pushEvent(job, { type: 'done', response: result, timestamp: nowIso() });
  notify(id);
  return job;
}

export function markResearchJobFailed(id: string, message: string, finalContext?: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.status = job.cancelled ? 'cancelled' : 'failed';
  job.error = message;
  if (finalContext !== undefined) job.finalContext = finalContext;
  job.finishedAt = nowIso();
  pushEvent(job, { type: 'error', message, finalContext, timestamp: nowIso() });
  notify(id);
  return job;
}

export function setResearchJobStatus(id: string, status: ResearchJobStatus, detail?: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.cancelled || job.status === 'completed' || job.status === 'failed') return job;
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
  return job;
}

export function setResearchJobRuntime(id: string, runtime: ResearchJobRuntime): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.runtime = runtime;
  job.updatedAt = nowIso();
  return job;
}

export function pauseResearchJob(id: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.status !== 'running' && job.status !== 'planning' && job.status !== 'searching' && job.status !== 'reviewing' && job.status !== 'synthesizing') {
    return undefined;
  }

  job.status = 'paused';
  job.updatedAt = nowIso();

  if (job.mode === 'deep' && job.depth && job.preset && job.runtime?.notebookId) {
    const existing = loadResearchCheckpoint(id);
    saveResearchCheckpoint({
      jobId: id,
      query: job.query,
      depth: job.depth,
      preset: job.preset,
      notebookId: job.runtime.notebookId,
      usedCredits: job.runtime.usedCredits,
      remainingCredits: job.runtime.remainingCredits,
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
    mode: 'deep',
    depth: checkpoint.depth,
    preset: checkpoint.preset,
    status: 'queued',
    createdAt: checkpoint.lastUpdatedAt,
    updatedAt: nowIso(),
    cancelled: false,
    steps: [],
    events: [],
    runtime: {
      usedCredits: checkpoint.usedCredits,
      remainingCredits: checkpoint.remainingCredits,
      round: checkpoint.round,
      notebookId: checkpoint.notebookId,
      sourceMap: checkpoint.sourceMap,
    },
  };
  jobs.set(checkpoint.jobId, job);
  pushEvent(job, { type: 'status', status: 'queued', detail: 'Recovered from checkpoint after server restart', timestamp: nowIso() });
  trimJobs();
  return job;
}

export function cancelResearchJob(id: string): ResearchJobRecord | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  job.cancelled = true;
  job.controller?.abort();
  job.status = 'cancelled';
  job.finishedAt = nowIso();
  pushEvent(job, { type: 'status', status: 'cancelled', timestamp: nowIso(), detail: 'Cancelled by user' });
  notify(id);
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
