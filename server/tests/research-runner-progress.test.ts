import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EngineEvent } from '../src/engine.js';
import { createResearchJob, getResearchJob } from '../src/research-jobs.js';
import { runResearchJob } from '../src/application/research-runner.js';

vi.mock('../src/engine.js', () => ({
  agenticResearchStream: vi.fn(),
}));

import { agenticResearchStream } from '../src/engine.js';

const mockedStream = vi.mocked(agenticResearchStream);

const DONE = {
  query: 'q',
  answer: 'a',
  sources: [],
  steps: [],
  results_count: 0,
  elapsed_ms: 1,
} as unknown as import('../src/schemas.js').SearchResponse;

beforeEach(() => {
  vi.resetAllMocks();
});

/**
 * The engine emits a progress note, the runner stores it, SSE replays it. The
 * middle link was missing: the runner's event switch had no `progress` case,
 * so the note reached the CLI console and nothing else while the API consumer
 * saw silence. This drives the runner with a stubbed engine and asserts the
 * note lands on the job under its own event type.
 */
describe('research runner progress wiring', () => {
  it.each(['short', 'long', 'exhaustive'] as const)('passes the requested %s response length to the engine', async (responseLength) => {
    mockedStream.mockImplementation(async (_query, _history, onEvent) => {
      onEvent({ type: 'done', response: DONE });
    });
    const job = createResearchJob({ query: 'q', mode: 'deep', responseLength, researchApi: true });

    await runResearchJob(job.id);

    expect(mockedStream).toHaveBeenCalledWith(
      'q', undefined, expect.any(Function), 'deep', expect.objectContaining({ responseLength }),
    );
  });

  it('stores an engine progress note as a progress_note job event', async () => {
    mockedStream.mockImplementation(async (_query, _history, onEvent: (ev: EngineEvent) => void) => {
      onEvent({ type: 'progress', data: { headline: 'Checking figures', body: 'Two sources agree.', round: 2 } });
      onEvent({ type: 'done', response: DONE });
    });
    const job = createResearchJob({ query: 'q', mode: 'default', researchApi: true });
    await runResearchJob(job.id);
    const events = getResearchJob(job.id)?.events ?? [];
    const note = events.find((event) => event.type === 'progress_note');
    expect(note).toMatchObject({
      type: 'progress_note',
      data: { headline: 'Checking figures', body: 'Two sources agree.', round: 2 },
    });
  });

  it('marks a declined run declined with the model reason', async () => {
    mockedStream.mockImplementation(async (_query, _history, onEvent: (ev: EngineEvent) => void) => {
      onEvent({ type: 'declined', reason: 'Just a greeting.' });
    });
    const job = createResearchJob({ query: 'hi', mode: 'instant', researchApi: true });
    await runResearchJob(job.id);
    const finished = getResearchJob(job.id);
    expect(finished?.status).toBe('declined');
    const statuses = (finished?.events ?? []).filter((event) => event.type === 'status');
    expect(statuses[statuses.length - 1]).toMatchObject({ type: 'status', status: 'declined', detail: 'Just a greeting.' });
  });

  it('keeps the runtime progress event separate from the note', async () => {
    mockedStream.mockImplementation(async (_query, _history, onEvent: (ev: EngineEvent) => void, _mode, options) => {
      options?.onProgress?.({
        budget: {} as never,
        budgetState: {} as never,
        round: 1,
        mode: 'default',
      });
      onEvent({ type: 'done', response: DONE });
    });
    const job = createResearchJob({ query: 'q', mode: 'default', researchApi: true });
    await runResearchJob(job.id);
    const events = getResearchJob(job.id)?.events ?? [];
    const runtime = events.find((event) => event.type === 'progress');
    expect(runtime).toBeDefined();
    expect(events.some((event) => event.type === 'progress_note')).toBe(false);
  });
});
