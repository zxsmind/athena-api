import { describe, it, expect, beforeEach } from 'vitest';

import {
  createResearchJob,
  getResearchJob,
  markResearchJobRunning,
  markResearchJobDone,
  markResearchJobFailed,
  cancelResearchJob,
  pauseResearchJob,
  resumeResearchJob,
  setResearchJobStatus,
  subscribeResearchJob,
} from '../src/research-jobs.js';

describe('ResearchJobs', () => {
  beforeEach(() => {
    // clean module state by inspecting internals
    // cancelResearchJob is safe to call on non-existent IDs
  });

  it('should create a job with queued status', () => {
    const job = createResearchJob({ query: 'What is AI?', mode: 'quick' });
    expect(job.status).toBe('queued');
    expect(job.query).toBe('What is AI?');
    expect(job.mode).toBe('quick');
    expect(job.cancelled).toBe(false);
    expect(job.id).toBeDefined();
  });

  it('should transition through granular states', () => {
    const job = createResearchJob({ query: 'Deep learning' });

    markResearchJobRunning(job.id);
    expect(getResearchJob(job.id)!.status).toBe('running');

    setResearchJobStatus(job.id, 'planning');
    expect(getResearchJob(job.id)!.status).toBe('planning');

    setResearchJobStatus(job.id, 'searching');
    expect(getResearchJob(job.id)!.status).toBe('searching');

    setResearchJobStatus(job.id, 'reviewing');
    expect(getResearchJob(job.id)!.status).toBe('reviewing');

    setResearchJobStatus(job.id, 'synthesizing');
    expect(getResearchJob(job.id)!.status).toBe('synthesizing');
  });

  it('should complete a job with result', () => {
    const job = createResearchJob({ query: 'Test', mode: 'deep' });
    markResearchJobRunning(job.id);

    const result = {
      query: 'Test',
      answer: 'Test answer',
      sources: [],
      steps: [],
      results_count: 0,
      elapsed_ms: 50,
    };

    const done = markResearchJobDone(job.id, result);
    expect(done!.status).toBe('completed');
    expect(done!.result).toEqual(result);
    expect(done!.finishedAt).toBeDefined();
  });

  it('should fail a job with error message', () => {
    const job = createResearchJob({ query: 'Fail test' });
    markResearchJobRunning(job.id);

    const failed = markResearchJobFailed(job.id, 'Provider unavailable');
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe('Provider unavailable');
  });

  it('should cancel a job', () => {
    const job = createResearchJob({ query: 'Cancel test' });
    markResearchJobRunning(job.id);

    const cancelled = cancelResearchJob(job.id);
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.cancelled).toBe(true);
  });

  it('should not change status after completion', () => {
    const job = createResearchJob({ query: 'Done test' });
    markResearchJobRunning(job.id);

    const result = {
      query: 'Done test',
      answer: 'Done',
      sources: [],
      steps: [],
      results_count: 0,
      elapsed_ms: 10,
    };
    markResearchJobDone(job.id, result);

    // Attempt to change after done should be ignored
    setResearchJobStatus(job.id, 'searching');
    expect(getResearchJob(job.id)!.status).toBe('completed');
  });

  it('should emit events through subscription', () => {
    const events: string[] = [];
    const job = createResearchJob({ query: 'Events test' });

    const unsub = subscribeResearchJob(job.id, (j) => {
      events.push(j.status);
    });

    markResearchJobRunning(job.id);
    setResearchJobStatus(job.id, 'searching');
    markResearchJobDone(job.id, {
      query: 'Events test', answer: 'Done', sources: [], steps: [], results_count: 0, elapsed_ms: 5,
    });

    expect(events.length).toBeGreaterThanOrEqual(3);

    unsub();
  });

  it('should not emit events after unsubscription', () => {
    const events: string[] = [];
    const job = createResearchJob({ query: 'Unsub test' });

    const unsub = subscribeResearchJob(job.id, (j) => {
      events.push(j.status);
    });
    unsub();

    markResearchJobRunning(job.id);
    expect(events.length).toBe(0);
  });

  it('should pause and resume a running job', () => {
    const job = createResearchJob({ query: 'Pause test', mode: 'deep', depth: 'high' });
    markResearchJobRunning(job.id);
    setResearchJobStatus(job.id, 'searching');

    const paused = pauseResearchJob(job.id);
    expect(paused!.status).toBe('paused');

    const resumed = resumeResearchJob(job.id);
    expect(resumed!.status).toBe('queued');

    markResearchJobRunning(job.id);
    expect(getResearchJob(job.id)!.status).toBe('running');
  });
});
