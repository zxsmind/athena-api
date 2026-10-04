import { describe, it, expect } from 'vitest';

import {
  createResearchJob,
  cancelResearchJob,
  markResearchJobRunning,
  pauseResearchJob,
  setResearchJobRuntime,
} from '../src/research-jobs.js';
import { createBudgetState, resolveResearchPreset } from '../src/engine/modes.js';
import { loadRecentResearchJobs, loadResearchJobEvents } from '../src/research-job-store.js';

/**
 * The job registry keeps a live map for the running process and mirrors every
 * state change into SQLite. These tests read the database directly, so they
 * check what actually survives a restart rather than what the in-memory map
 * happens to hold right now.
 */

function newJob(query: string) {
  const preset = resolveResearchPreset('deep', 'standard');
  return createResearchJob({ query, mode: 'deep', preset, researchApi: true });
}

function storedRow(id: string) {
  return loadRecentResearchJobs(500).find((row) => row.id === id) ?? null;
}

describe('research job persistence', () => {
  it('writes a created job to SQLite', () => {
    const job = newJob('persistence-create');
    const row = storedRow(job.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('queued');
  });

  it('persists the terminal status of a cancelled job', () => {
    const job = newJob('persistence-cancel');
    cancelResearchJob(job.id);

    /* Cancelling only updates the live map plus one status event. If the
       snapshot were not rewritten, a restart would resurrect the job as
       running rather than cancelled. */
    const row = storedRow(job.id);
    expect(row?.status).toBe('cancelled');
  });

  it('persists a paused job so it is not restarted by a later boot', () => {
    const job = newJob('persistence-pause');
    markResearchJobRunning(job.id);
    /* pauseResearchJob only accepts a job that is actually in flight. */
    expect(pauseResearchJob(job.id)?.status).toBe('paused');
    expect(storedRow(job.id)?.status).toBe('paused');
  });

  it('stores the runtime budget ledger inside the persisted snapshot', () => {
    const job = newJob('persistence-ledger');
    setResearchJobRuntime(job.id, {
      budget: { ...createBudgetState(), usedSearchCalls: 2, usedTokens: 500 },
      round: 3,
      sourceMap: [],
    });
    cancelResearchJob(job.id);

    /* The ledger is what keeps token billing honest across a restart, so it has
       to live in the persisted JSON and not only in the live map. */
    const row = storedRow(job.id);
    const data = row ? JSON.parse(row.data) as { runtime?: { budget?: { tokenLedger?: unknown } } } : null;
    expect(data?.runtime?.budget).toBeDefined();
    expect(data?.runtime?.budget?.tokenLedger).toBeDefined();
    expect(data?.runtime?.budget?.usedSearchCalls).toBe(2);
  });

  it('stores events with a monotonic sequence', () => {
    const job = newJob('persistence-events');
    cancelResearchJob(job.id);
    const seqs = loadResearchJobEvents(job.id, 100).map((raw) => (JSON.parse(raw) as { seq?: number }).seq ?? 0);
    expect(seqs.length).toBeGreaterThan(0);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });
});
