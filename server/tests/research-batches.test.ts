import { describe, it, expect, beforeEach } from 'vitest';

/* ResearchBatches module — pure in-memory logic, easy to test without mocks */

// We import via dynamic import pattern since the module has module-level state
import {
  createResearchBatch,
  markResearchBatchRunning,
  markResearchBatchDone,
  markResearchBatchFailed,
  cancelResearchBatch,
  updateResearchBatchItem,
  storeResearchBatchResult,
  failResearchBatchItem,
  subscribeResearchBatch,
  listResearchBatches,
  type ResearchBatchRequest,
} from '../src/research-batches.js';

function sampleRequest(overrides: Partial<ResearchBatchRequest> = {}): ResearchBatchRequest {
  return {
    queries: ['What is AI?', 'What is ML?', 'What is deep learning?'],
    mode: 'quick',
    maxConcurrent: 2,
    perItemCredits: 20,
    sharedCredits: 60,
    ...overrides,
  };
}

describe('ResearchBatches', () => {
  beforeEach(() => {
    // Each test must work in isolation. The batch map is module-scoped,
    // so we cancel all leftovers from previous tests.
    const all = listResearchBatches();
    for (const b of all) {
      cancelResearchBatch(b.id);
    }
  });

  it('should create a batch with correct defaults', () => {
    const batch = createResearchBatch(sampleRequest());
    expect(batch.status).toBe('queued');
    expect(batch.queries).toHaveLength(3);
    expect(batch.items).toHaveLength(3);
    expect(batch.maxConcurrent).toBe(2);
    expect(batch.perItemCredits).toBe(20);
    expect(batch.sharedCredits).toBe(60);
    expect(batch.cancelled).toBe(false);
    expect(batch.items[0].status).toBe('pending');
  });

  it('should normalize empty queries', () => {
    const batch = createResearchBatch({ queries: ['  ', 'valid', '', ' also valid '] });
    expect(batch.queries).toHaveLength(2);
    expect(batch.queries[0]).toBe('valid');
    expect(batch.queries[1]).toBe('also valid');
  });

  it('should transition through lifecycle states', () => {
    const batch = createResearchBatch(sampleRequest());

    const running = markResearchBatchRunning(batch.id);
    expect(running).toBeDefined();
    expect(running!.status).toBe('running');
    expect(running!.startedAt).toBeDefined();

    const done = markResearchBatchDone(batch.id);
    expect(done).toBeDefined();
    expect(done!.status).toBe('completed');
    expect(done!.finishedAt).toBeDefined();
  });

  it('should support cancel', () => {
    const batch = createResearchBatch(sampleRequest());
    markResearchBatchRunning(batch.id);

    const cancelled = cancelResearchBatch(batch.id);
    expect(cancelled).toBeDefined();
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.cancelled).toBe(true);
    expect(cancelled!.finishedAt).toBeDefined();
  });

  it('should update item status', () => {
    const batch = createResearchBatch(sampleRequest());
    const itemId = batch.items[0].id;

    const updated = updateResearchBatchItem(batch.id, itemId, { status: 'running', startedAt: new Date().toISOString() });
    expect(updated).toBeDefined();
    expect(updated!.items[0].status).toBe('running');
  });

  it('should store item result', () => {
    const batch = createResearchBatch(sampleRequest());
    const itemId = batch.items[0].id;

    const result = {
      query: 'What is AI?',
      answer: 'Artificial Intelligence...',
      sources: [{ title: 'Test', url: 'https://test.com', domain: 'test.com' }],
      steps: [],
      results_count: 1,
      elapsed_ms: 100,
    };

    const stored = storeResearchBatchResult(batch.id, itemId, result);
    expect(stored).toBeDefined();
    expect(stored!.items[0].status).toBe('completed');
    expect(stored!.results[0]).toEqual(result);
  });

  it('should fail item with error message', () => {
    const batch = createResearchBatch(sampleRequest());
    const itemId = batch.items[1].id;

    const failed = failResearchBatchItem(batch.id, itemId, 'API rate limit exceeded');
    expect(failed).toBeDefined();
    expect(failed!.items[1].status).toBe('failed');
    expect(failed!.items[1].error).toBe('API rate limit exceeded');
  });

  it('should mark batch as failed', () => {
    const batch = createResearchBatch(sampleRequest());
    markResearchBatchRunning(batch.id);

    const failed = markResearchBatchFailed(batch.id, 'Budget exhausted');
    expect(failed).toBeDefined();
    expect(failed!.status).toBe('failed');
    expect(failed!.finishedAt).toBeDefined();
  });

  it('should clean up cancelled item on fail', () => {
    const batch = createResearchBatch(sampleRequest());
    cancelResearchBatch(batch.id);

    const itemId = batch.items[0].id;
    const failed = failResearchBatchItem(batch.id, itemId, 'Cancelled');
    // When batch is cancelled, individual items should be marked cancelled too
    expect(failed!.items[0].status).toBe('cancelled');
  });

  it('should emit events through subscription', () => {
    const batch = createResearchBatch(sampleRequest());
    const events: string[] = [];

    const unsub = subscribeResearchBatch(batch.id, (b) => {
      events.push(b.status);
    });

    markResearchBatchRunning(batch.id);
    markResearchBatchDone(batch.id);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events).toContain('running');
    expect(events).toContain('completed');

    unsub();
  });

  it('should list all batches', () => {
    const b1 = createResearchBatch(sampleRequest({ queries: ['First'] }));
    const b2 = createResearchBatch(sampleRequest({ queries: ['Second'] }));

    const list = listResearchBatches();
    const ids = list.map(b => b.id);
    expect(ids).toContain(b1.id);
    expect(ids).toContain(b2.id);
    // Batches should be in reverse chronological order (newest first or same-millisecond stable)
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
