import { getConfig } from '../config/load.js';
import { cleanupStaleCheckpoints } from '../engine/checkpoint.js';
import {
  cancelStalePausedJobs,
  listResearchJobs,
  purgeOldJobs,
} from '../research-jobs.js';
import { deleteTrace, pruneOldTraces } from '../trace.js';

/**
 * Data retention: one hourly pass that enforces the yaml ceilings.
 *
 * - Paused jobs past `research.pausedTtlMinutes` are cancelled (record kept).
 * - Terminal jobs past `storage.retentionMinutes` are purged with their
 *   SQLite rows and trace files.
 * - Checkpoints and trace files with no live job are pruned by age.
 * - Running jobs, live paused jobs, logs, and settings are never touched;
 *   the log file has its own rotation (`logging.maxFileBytes`, `keepFiles`).
 *
 * Order matters: the paused sweep runs first so a job cancelled for idleness
 * keeps its full retention period as a cancelled record instead of vanishing
 * in the same pass.
 */

export interface RetentionSweep {
  pausedCancelled: string[];
  jobsPurged: string[];
  tracesPruned: string[];
  checkpointsRemoved: number;
}

export function sweepRetention(pausedTtlMs: number, retentionMs: number, nowMs: number = Date.now()): RetentionSweep {
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
  return { pausedCancelled, jobsPurged, tracesPruned, checkpointsRemoved };
}

let retentionTimer: ReturnType<typeof setInterval> | null = null;

/** Hourly retention pass; runs in production, stopped in tests. */
export function startRetentionSweeper(pausedTtlMs: number, retentionMs: number, intervalMs = 3_600_000): void {
  stopRetentionSweeper();
  retentionTimer = setInterval(() => {
    try {
      const sweep = sweepRetention(pausedTtlMs, retentionMs);
      const total = sweep.pausedCancelled.length + sweep.jobsPurged.length + sweep.tracesPruned.length + sweep.checkpointsRemoved;
      if (total > 0) console.log(`[retention] paused=${sweep.pausedCancelled.length} jobs=${sweep.jobsPurged.length} traces=${sweep.tracesPruned.length} checkpoints=${sweep.checkpointsRemoved}`);
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

/** Resolves the sweep windows from configuration. */
export function retentionWindows(): { pausedTtlMs: number; retentionMs: number } {
  return {
    pausedTtlMs: getConfig().research.pausedTtlMinutes * 60_000,
    retentionMs: getConfig().storage.retentionMinutes * 60_000,
  };
}
