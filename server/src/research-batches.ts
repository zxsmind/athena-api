import { randomUUID } from 'crypto';
import type { SearchResponse, Source } from './schemas.js';

export type ResearchBatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ResearchBatchRequest {
  queries: string[];
  history?: { role: string; content: string }[];
  mode?: 'quick' | 'deep';
  maxConcurrent?: number;
  sharedCredits?: number;
  perItemCredits?: number;
}

export interface ResearchBatchItem {
  id: string;
  query: string;
  status: ResearchBatchStatus | 'pending';
  result?: SearchResponse;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export type ResearchBatchEvent =
  | { type: 'status'; status: ResearchBatchStatus; detail?: string; timestamp: string }
  | { type: 'item'; item: ResearchBatchItem; timestamp: string }
  | { type: 'step'; itemId: string; note?: string; query?: string; model?: string; timestamp: string }
  | { type: 'token'; itemId: string; text: string; timestamp: string }
  | { type: 'sources'; itemId: string; sources: Source[]; timestamp: string }
  | { type: 'done'; batch: ResearchBatchSnapshot; timestamp: string }
  | { type: 'error'; message: string; timestamp: string };

export interface ResearchBatchRecord {
  id: string;
  queries: string[];
  history?: { role: string; content: string }[];
  mode: 'quick' | 'deep';
  maxConcurrent: number;
  sharedCredits: number;
  perItemCredits: number;
  status: ResearchBatchStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelled: boolean;
  controller?: AbortController;
  items: ResearchBatchItem[];
  results: Array<SearchResponse | null>;
  events: ResearchBatchEvent[];
}

export interface ResearchBatchSnapshot {
  id: string;
  status: ResearchBatchStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelled: boolean;
  items: ResearchBatchItem[];
  results: Array<SearchResponse | null>;
}

const batches = new Map<string, ResearchBatchRecord>();
const listeners = new Map<string, Set<(batch: ResearchBatchRecord) => void>>();
export let MAX_EVENTS = 300;
export let MAX_BATCHES = 50;

export function applyAPISettings(opts: { maxActiveBatches?: number; maxEventsPerBatch?: number }) {
  if (opts.maxActiveBatches !== undefined) MAX_BATCHES = Math.max(1, opts.maxActiveBatches);
  if (opts.maxEventsPerBatch !== undefined) MAX_EVENTS = Math.max(10, opts.maxEventsPerBatch);
}

function nowIso(): string {
  return new Date().toISOString();
}

function trimBatches() {
  if (batches.size <= MAX_BATCHES) return;
  const ordered = Array.from(batches.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  while (ordered.length > MAX_BATCHES) {
    const removed = ordered.shift();
    if (!removed) break;
    batches.delete(removed.id);
    listeners.delete(removed.id);
  }
}

function notify(id: string) {
  const batch = batches.get(id);
  if (!batch) return;
  const subs = listeners.get(id);
  if (!subs) return;
  for (const fn of subs) {
    try {
      fn(batch);
    } catch {
      // ignore listener faults
    }
  }
}

function pushEvent(batch: ResearchBatchRecord, event: ResearchBatchEvent) {
  batch.events.push(event);
  if (batch.events.length > MAX_EVENTS) {
    batch.events.splice(0, batch.events.length - MAX_EVENTS);
  }
  batch.updatedAt = nowIso();
}

function snapshotBatch(batch: ResearchBatchRecord): ResearchBatchSnapshot {
  return {
    id: batch.id,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    cancelled: batch.cancelled,
    items: batch.items.map(item => ({ ...item })),
    results: batch.results.slice(),
  };
}

function normalizeQueries(queries: string[]): string[] {
  return queries.map(q => q.trim()).filter(q => q.length > 0);
}

export function createResearchBatch(req: ResearchBatchRequest): ResearchBatchRecord {
  const id = randomUUID();
  const queries = normalizeQueries(req.queries);
  const perItemCredits = Math.max(1, req.perItemCredits || 20);
  const sharedCredits = Math.max(1, req.sharedCredits || perItemCredits * queries.length);
  const batch: ResearchBatchRecord = {
    id,
    queries,
    history: req.history,
    mode: req.mode || 'quick',
    maxConcurrent: Math.max(1, req.maxConcurrent || 2),
    sharedCredits,
    perItemCredits,
    status: 'queued',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    cancelled: false,
    items: queries.map(query => ({ id: randomUUID(), query, status: 'pending' })),
    results: queries.map(() => null),
    events: [],
  };
  batches.set(id, batch);
  pushEvent(batch, { type: 'status', status: 'queued', timestamp: nowIso() });
  trimBatches();
  return batch;
}

export function getResearchBatch(id: string): ResearchBatchRecord | undefined {
  return batches.get(id);
}

export function listResearchBatches(): ResearchBatchRecord[] {
  return Array.from(batches.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function subscribeResearchBatch(id: string, listener: (batch: ResearchBatchRecord) => void): () => void {
  const subs = listeners.get(id) || new Set<(batch: ResearchBatchRecord) => void>();
  subs.add(listener);
  listeners.set(id, subs);
  return () => {
    const current = listeners.get(id);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(id);
  };
}

export function attachResearchBatchController(id: string, controller: AbortController): ResearchBatchRecord | undefined {
  const batch = batches.get(id);
  if (!batch) return undefined;
  batch.controller = controller;
  return batch;
}

export function markResearchBatchRunning(id: string): ResearchBatchRecord | undefined {
  const batch = batches.get(id);
  if (!batch) return undefined;
  batch.status = 'running';
  batch.startedAt = batch.startedAt || nowIso();
  pushEvent(batch, { type: 'status', status: 'running', timestamp: nowIso() });
  notify(id);
  return batch;
}

export function updateResearchBatchItem(
  id: string,
  itemId: string,
  patch: Partial<ResearchBatchItem>,
): ResearchBatchRecord | undefined {
  const batch = batches.get(id);
  if (!batch) return undefined;
  const idx = batch.items.findIndex(item => item.id === itemId);
  if (idx < 0) return batch;
  batch.items[idx] = { ...batch.items[idx], ...patch };
  pushEvent(batch, { type: 'item', item: batch.items[idx], timestamp: nowIso() });
  notify(id);
  return batch;
}

export function storeResearchBatchResult(
  id: string,
  itemId: string,
  result: SearchResponse,
): ResearchBatchRecord | undefined {
  const batch = batches.get(id);
  if (!batch) return undefined;
  const idx = batch.items.findIndex(item => item.id === itemId);
  if (idx < 0) return batch;
  batch.items[idx] = {
    ...batch.items[idx],
    status: 'completed',
    result,
    finishedAt: nowIso(),
  };
  batch.results[idx] = result;
  pushEvent(batch, { type: 'item', item: batch.items[idx], timestamp: nowIso() });
  notify(id);
  return batch;
}

export function failResearchBatchItem(
  id: string,
  itemId: string,
  message: string,
): ResearchBatchRecord | undefined {
  const batch = batches.get(id);
  if (!batch) return undefined;
  const idx = batch.items.findIndex(item => item.id === itemId);
  if (idx < 0) return batch;
  batch.items[idx] = {
    ...batch.items[idx],
    status: batch.cancelled ? 'cancelled' : 'failed',
    error: message,
    finishedAt: nowIso(),
  };
  pushEvent(batch, { type: 'item', item: batch.items[idx], timestamp: nowIso() });
  notify(id);
  return batch;
}

export function markResearchBatchDone(id: string): ResearchBatchRecord | undefined {
  const batch = batches.get(id);
  if (!batch) return undefined;
  batch.status = 'completed';
  batch.finishedAt = nowIso();
  pushEvent(batch, { type: 'done', batch: snapshotBatch(batch), timestamp: nowIso() });
  notify(id);
  return batch;
}

export function markResearchBatchFailed(id: string, message: string): ResearchBatchRecord | undefined {
  const batch = batches.get(id);
  if (!batch) return undefined;
  batch.status = batch.cancelled ? 'cancelled' : 'failed';
  batch.finishedAt = nowIso();
  pushEvent(batch, { type: 'error', message, timestamp: nowIso() });
  notify(id);
  return batch;
}

export function appendResearchBatchEvent(id: string, event: ResearchBatchEvent): ResearchBatchRecord | undefined {
  const batch = batches.get(id);
  if (!batch) return undefined;
  if (batch.cancelled && event.type !== 'status') return batch;
  pushEvent(batch, event);
  notify(id);
  return batch;
}

export function cancelResearchBatch(id: string): ResearchBatchRecord | undefined {
  const batch = batches.get(id);
  if (!batch) return undefined;
  batch.cancelled = true;
  batch.controller?.abort();
  batch.status = 'cancelled';
  batch.finishedAt = nowIso();
  pushEvent(batch, { type: 'status', status: 'cancelled', timestamp: nowIso(), detail: 'Cancelled by user' });
  notify(id);
  return batch;
}
