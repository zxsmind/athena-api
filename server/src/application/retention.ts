import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config/load.js';
import { getDataPath, reclaimDatabaseSpace } from '../storage.js';
import { loadSettings } from '../settings-store.js';
import { checkpointFilePath, cleanupStaleCheckpoints, deleteResearchCheckpoint, listResearchCheckpoints } from '../engine/checkpoint.js';
import {
  cancelStalePausedJobs,
  listResearchJobs,
  purgeOldJobs,
  removeJobRecord,
} from '../research-jobs.js';
import { deleteTrace, pruneOldTraces, traceFileBytes, tracesDirPath } from '../trace.js';

/**
 * Data retention: one hourly pass that enforces a single window.
 *
 * - Paused jobs past `research.pausedTtlMinutes` are cancelled (record kept).
 * - Everything persisted — terminal jobs and their events, trace files,
 *   checkpoints, request history, daily rollups — dies at one age, from
 *   `api.maxRetentionMinutes`. Splitting them was the visible bug: jobs went
 *   after a day while the dashboard kept counting requests from a month back,
 *   so two panels of one product disagreed about what exists.
 * - Dead pages are handed back afterwards, so the file on disk tracks the data
 *   it holds instead of carrying every page it ever wrote.
 * - Running jobs, live paused jobs, logs, and settings are never touched;
 *   the log file has its own rotation (`logging.maxFileBytes`, `keepFiles`).
 *
 * Order matters: the paused sweep runs first so a job cancelled for idleness
 * keeps its full retention period as a cancelled record instead of vanishing
 * in the same pass.
 */

/** The usage history the sweep ages out. `ApiPlatformStore` satisfies it. */
export interface UsageHistory {
  pruneOlderThan(cutoffIso: string): { requests: number; usageDays: number };
}

export interface RetentionSweep {
  pausedCancelled: string[];
  jobsPurged: string[];
  tracesPruned: string[];
  checkpointsRemoved: number;
  bytesFreed: number;
  /** Usage rows dropped by the same window: raw requests and daily rollups. */
  requestsPruned: number;
  usageDaysPruned: number;
  /** Dead pages returned to the file system; 0 when there was nothing to reclaim. */
  pagesReclaimed: number;
}

export function sweepRetention(
  usage: UsageHistory,
  pausedTtlMs: number,
  retentionMs: number,
  maxDataBytes: number,
  nowMs: number = Date.now(),
): RetentionSweep {
  const pausedCancelled = cancelStalePausedJobs(pausedTtlMs, nowMs);
  const jobsPurged = purgeOldJobs(retentionMs, nowMs);
  for (const id of jobsPurged) {
    try {
      deleteTrace(id);
    } catch { /* a missing trace is not a failure */ }
  }
  const liveIds = new Set(listResearchJobs().map((job) => job.id));
  const tracesPruned = pruneOldTraces(retentionMs, liveIds, nowMs);
  const checkpointsRemoved = cleanupStaleCheckpoints(retentionMs, liveIds);
  const bytesFreed = enforceDataBudget(maxDataBytes);
  /* The same cutoff, applied to what the dashboard counts. */
  const cutoffIso = new Date(nowMs - retentionMs).toISOString();
  const pruned = usage.pruneOlderThan(cutoffIso);
  /* Deleting is not the same as shrinking: SQLite keeps the pages until the
     vacuum runs, which is what made a 569 MB file out of 600 KB of rows. */
  const pagesReclaimed = reclaimDatabaseSpace();
  return {
    pausedCancelled,
    jobsPurged,
    tracesPruned,
    checkpointsRemoved,
    bytesFreed,
    requestsPruned: pruned.requests,
    usageDaysPruned: pruned.usageDays,
    pagesReclaimed,
  };
}

/** Recursive byte size of a directory; missing counts as zero. */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSizeBytes(full);
      else total += statSync(full).size;
    } catch { /* vanishing files contribute nothing */ }
  }
  return total;
}

/**
 * Hard ceiling on the data directory. Age retention runs first and usually
 * suffices; this is the guard for pathological growth (a runaway trace, a
 * flood of jobs). Deletion order, oldest first:
 * terminal job data (rows, events, traces), then orphan checkpoints, then
 * orphan traces. Live jobs, settings, keys, logs, and the models cache are
 * never touched. Returns bytes freed.
 */
export function enforceDataBudget(maxBytes: number): number {
  if (maxBytes <= 0) return 0;
  const dataDir = getDataPath();
  let freed = 0;
  const size = (): number => dirSizeBytes(dataDir);
  /* Terminal jobs, oldest first: the record, its rows, and its traces.
     Running and paused jobs are spared by status, whatever their age. */
  const terminal = listResearchJobs()
    .filter((job) => ['completed', 'failed', 'cancelled', 'declined'].includes(job.status))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const job of terminal) {
    if (size() <= maxBytes) break;
    const before = traceFileBytes(job.id);
    if (removeJobRecord(job.id)) {
      deleteTrace(job.id);
      freed += before;
    }
  }
  /* Orphan checkpoints and traces (no live job), oldest first. */
  if (size() > maxBytes) {
    const liveIds = new Set(listResearchJobs().map((job) => job.id));
    const orphans: Array<{ id: string; file: string; mtime: number }> = [];
    for (const cp of listResearchCheckpoints()) {
      if (liveIds.has(cp.jobId)) continue;
      try {
        const file = checkpointFilePath(cp.jobId);
        orphans.push({ id: cp.jobId, file, mtime: statSync(file).mtimeMs });
      } catch { /* ignore */ }
    }
    try {
      for (const name of readdirSync(tracesDirPath())) {
        if (!name.endsWith('.jsonl') && !name.endsWith('.live.log')) continue;
        const id = name.replace(/\.jsonl$/, '').replace(/\.live\.log$/, '');
        if (liveIds.has(id) || orphans.some((o) => o.id === id)) continue;
        const file = join(tracesDirPath(), name);
        try {
          orphans.push({ id, file, mtime: statSync(file).mtimeMs });
        } catch { /* ignore */ }
      }
    } catch { /* no traces dir */ }
    orphans.sort((a, b) => a.mtime - b.mtime);
    for (const orphan of orphans) {
      if (size() <= maxBytes) break;
      try {
        freed += statSync(orphan.file).size;
        if (orphan.file.endsWith('.json')) deleteResearchCheckpoint(orphan.id);
        else deleteTrace(orphan.id);
      } catch { /* ignore */ }
    }
  }
  return freed;
}

let retentionTimer: ReturnType<typeof setInterval> | null = null;

/** Hourly retention pass; runs in production, stopped in tests. */
export function startRetentionSweeper(
  usage: UsageHistory,
  pausedTtlMs: number,
  retentionMs: number,
  maxDataBytes: number,
  intervalMs = 3_600_000,
): void {
  stopRetentionSweeper();
  retentionTimer = setInterval(() => {
    try {
      const sweep = sweepRetention(usage, pausedTtlMs, retentionMs, maxDataBytes);
      const total =
        sweep.pausedCancelled.length + sweep.jobsPurged.length + sweep.tracesPruned.length +
        sweep.checkpointsRemoved + sweep.bytesFreed + sweep.requestsPruned + sweep.usageDaysPruned + sweep.pagesReclaimed;
      if (total > 0) {
        console.log(
          `[retention] paused=${sweep.pausedCancelled.length} jobs=${sweep.jobsPurged.length} traces=${sweep.tracesPruned.length} ` +
          `checkpoints=${sweep.checkpointsRemoved} requests=${sweep.requestsPruned} usageDays=${sweep.usageDaysPruned} ` +
          `bytes=${sweep.bytesFreed} pages=${sweep.pagesReclaimed}`,
        );
      }
    } catch (error) {
      console.error('[retention] sweep failed:', error instanceof Error ? error.message : String(error));
    }
  }, intervalMs);
  if (typeof retentionTimer.unref === 'function') retentionTimer.unref();
}

export function stopRetentionSweeper(): void {
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
}

/**
 * Resolves the sweep windows from configuration.
 *
 * One number decides the age of every kind of record. `settings.yaml` owns it
 * (the console edits it); `config.yaml`'s `storage.retentionMinutes` — where
 * `ATHENA_RETENTION_MINUTES` also lands — overrides it when present, so a
 * deployment can pin a different lifetime without touching settings.
 */
export function retentionWindows(): { pausedTtlMs: number; retentionMs: number; maxDataBytes: number } {
  const config = getConfig();
  const retentionMinutes = config.storage.retentionMinutes ?? loadSettings().api.maxRetentionMinutes;
  return {
    pausedTtlMs: config.research.pausedTtlMinutes * 60_000,
    retentionMs: retentionMinutes * 60_000,
    maxDataBytes: config.storage.maxDataBytes,
  };
}
