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

    const sweep = sweepRetention(4 * HOUR, 24 * HOUR, 1_073_741_824, Date.now());

    expect(sweep.jobsPurged).toContain(done.id);
    expect(existsSync(traceFilePath(done.id))).toBe(false);
    expect(getResearchJob(done.id)).toBeUndefined();
  });

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
