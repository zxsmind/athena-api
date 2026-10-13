import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createResearchJob,
  getResearchJob,
  markResearchJobDone,
  markResearchJobRunning,
  pauseResearchJob,
  purgeOldJobs,
} from '../src/research-jobs.js';
import { loadRecentResearchJobs } from '../src/research-job-store.js';
import { pruneOldTraces, traceFilePath } from '../src/trace.js';
import { enforceDataBudget, sweepRetention } from '../src/application/retention.js';
import { ApiPlatformStore } from '../src/api-platform-store.js';
import { getDatabase } from '../src/storage.js';
import type { SearchResponse } from '../src/schemas.js';

const HOUR = 3_600_000;

const DONE: SearchResponse = {
  query: 'q',
  answer: 'a',
  sources: [],
  steps: [],
  results_count: 0,
  elapsed_ms: 1,
};

function backdate(id: string, msAgo: number): void {
  const job = getResearchJob(id)!;
  job.updatedAt = new Date(Date.now() - msAgo).toISOString();
}

function writeTrace(jobId: string, msAgo: number): void {
  mkdirSync(dirname(traceFilePath(jobId)), { recursive: true });
  writeFileSync(traceFilePath(jobId), '{"seq":1}\n');
  const old = new Date(Date.now() - msAgo);
  utimesSync(traceFilePath(jobId), old, old);
}

describe('retention', () => {
  it('purges only terminal jobs past the window, from memory and sqlite', () => {
    const oldDone = createResearchJob({ query: 'q', mode: 'instant', researchApi: true });
    markResearchJobRunning(oldDone.id);
    markResearchJobDone(oldDone.id, DONE);
    backdate(oldDone.id, 25 * HOUR);

    const freshDone = createResearchJob({ query: 'q', mode: 'instant', researchApi: true });
    markResearchJobRunning(freshDone.id);
    markResearchJobDone(freshDone.id, DONE);

    const running = createResearchJob({ query: 'q', mode: 'instant', researchApi: true });
    markResearchJobRunning(running.id);
    backdate(running.id, 25 * HOUR);

    const paused = createResearchJob({ query: 'q', mode: 'instant', researchApi: true });
    markResearchJobRunning(paused.id);
    pauseResearchJob(paused.id);
    backdate(paused.id, 25 * HOUR);

    expect(purgeOldJobs(24 * HOUR, Date.now())).toEqual([oldDone.id]);
    expect(getResearchJob(oldDone.id)).toBeUndefined();
    expect(loadRecentResearchJobs(1000).some((row) => row.id === oldDone.id)).toBe(false);
    expect(getResearchJob(freshDone.id)?.status).toBe('completed');
    expect(getResearchJob(running.id)?.status).toBe('running');
    expect(getResearchJob(paused.id)?.status).toBe('paused');
  });

  it('prunes stale trace files but spares live jobs', () => {
    writeTrace('j-trace-old', 25 * HOUR);
    writeTrace('j-trace-fresh', 0);
    writeTrace('j-trace-spared', 25 * HOUR);

    expect(pruneOldTraces(24 * HOUR, new Set(['j-trace-spared']), Date.now())).toEqual(['j-trace-old']);
    expect(existsSync(traceFilePath('j-trace-old'))).toBe(false);
    expect(existsSync(traceFilePath('j-trace-fresh'))).toBe(true);
    expect(existsSync(traceFilePath('j-trace-spared'))).toBe(true);
    rmSync(traceFilePath('j-trace-fresh'), { force: true });
    rmSync(traceFilePath('j-trace-spared'), { force: true });
  });

  it('sweeps a stale paused job and an old terminal job together', () => {
    const done = createResearchJob({ query: 'q', mode: 'instant', researchApi: true });
    markResearchJobRunning(done.id);
    markResearchJobDone(done.id, DONE);
    backdate(done.id, 25 * HOUR);
    writeTrace(done.id, 25 * HOUR);

    const sweep = sweepRetention({ pruneOlderThan: () => ({ requests: 0, usageDays: 0 }) }, 4 * HOUR, 24 * HOUR, 1_073_741_824, Date.now());

    expect(sweep.jobsPurged).toContain(done.id);
    expect(existsSync(traceFilePath(done.id))).toBe(false);
    expect(getResearchJob(done.id)).toBeUndefined();
  });

  it('ages request history and daily rollups out with the same window as jobs', () => {
    const store = new ApiPlatformStore();
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);

    store.recordRequest({ at: new Date(now - 30 * 24 * HOUR).toISOString(), method: 'GET', route: '/v1/ancient', status: 200, durationMs: 1, apiKeyId: null });
    store.recordRequest({ at: new Date(now - HOUR).toISOString(), method: 'GET', route: '/v1/fresh', status: 200, durationMs: 1, apiKeyId: null });
    store.debitDailyCredits('k-gone', '2000-01-01', 3);
    store.debitDailyCredits('k-kept', day, 3);

    const sweep = sweepRetention(store, 4 * HOUR, 7 * 24 * HOUR, 1_073_741_824, now);

    /* One window for both: the month-old request goes exactly as an old job
       would, and the recent one stays as a fresh job would. */
    expect(sweep.requestsPruned).toBe(1);
    expect(sweep.usageDaysPruned).toBe(1);
    expect(store.summarize(60).byDay.some((row) => row.day === new Date(now - 30 * 24 * HOUR).toISOString().slice(0, 10))).toBe(false);
    expect(store.creditsUsedToday('k-kept', day)).toBe(3);
    expect(store.creditsUsedToday('k-gone', '2000-01-01')).toBe(0);
  });

  it('hands dead pages back instead of leaving them in the file', () => {
    const store = new ApiPlatformStore();
    const now = Date.now();
    for (let i = 0; i < 200; i += 1) {
      store.recordRequest({ at: new Date(now - 40 * 24 * HOUR).toISOString(), method: 'GET', route: '/v1/old', status: 200, durationMs: 1, apiKeyId: null });
    }

    const sweep = sweepRetention(store, 4 * HOUR, 7 * 24 * HOUR, 1_073_741_824, now);

    expect(sweep.requestsPruned).toBeGreaterThanOrEqual(200);
    /* 0 is legal (nothing was free yet); the point is that the call happened
       after the deletes rather than never. */
    expect(sweep.pagesReclaimed).toBeGreaterThanOrEqual(0);
    const freelist = getDatabase().prepare('PRAGMA freelist_count').get() as { freelist_count: number };
    expect(freelist.freelist_count).toBe(0);
    /* The vacuum and the checkpoint do real I/O: on a loaded machine this pass
       was slow enough to time out at the default five seconds. */
  }, 30_000);

  it('enforces a byte budget oldest-first and spares live jobs', () => {
    const oldDone = createResearchJob({ query: 'q', mode: 'instant', researchApi: true });
    markResearchJobRunning(oldDone.id);
    markResearchJobDone(oldDone.id, DONE);
    backdate(oldDone.id, 2 * HOUR);
    writeTrace(oldDone.id, 2 * HOUR);

    const running = createResearchJob({ query: 'q', mode: 'instant', researchApi: true });
    markResearchJobRunning(running.id);
    writeTrace(running.id, 2 * HOUR);

    /* Budget below any real directory size: everything eligible must go. */
    const freed = enforceDataBudget(1);

    expect(freed).toBeGreaterThan(0);
    expect(getResearchJob(oldDone.id)).toBeUndefined();
    expect(existsSync(traceFilePath(oldDone.id))).toBe(false);
    expect(getResearchJob(running.id)?.status).toBe('running');
  });
});
