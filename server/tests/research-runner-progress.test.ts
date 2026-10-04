import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { EngineEvent } from '../src/engine.js';
import { createResearchJob, getResearchJob } from '../src/research-jobs.js';
import { runResearchJob } from '../src/application/research-runner.js';
import { defaultConfig } from '../src/config/defaults.js';
import { resetConfigForTests, setConfig } from '../src/config/load.js';

vi.mock('../src/engine.js', () => ({
  agenticResearchStream: vi.fn(),
}));

vi.mock('../src/llm.js', () => ({
  callLLM: vi.fn(),
}));

import { agenticResearchStream } from '../src/engine.js';
import { callLLM } from '../src/llm.js';

const mockedCallLLM = vi.mocked(callLLM);

function shortStall(ms = 300): void {
  setConfig({ ...defaultConfig, research: { ...defaultConfig.research, stallTimeoutMs: ms } });
}

afterEach(() => {
  resetConfigForTests();
});

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

describe('stall watchdog', () => {
  it('fails a run that goes silent instead of hanging forever', async () => {
    shortStall();
    /* Engine that never emits and never settles: abort alone cannot release
       an await on a promise like this, so the race must. */
    mockedStream.mockImplementation(() => new Promise<never>(() => {}));
    const job = createResearchJob({ query: 'q', mode: 'instant', researchApi: true });

    await runResearchJob(job.id);

    const finished = getResearchJob(job.id);
    expect(finished?.status).toBe('failed');
    expect(finished?.error).toMatch(/stalled/i);
  }, 10_000);

  it('salvages a partial answer from gathered evidence on stall', async () => {
    shortStall();
    mockedStream.mockImplementation(async (_query, _history, _onEvent, _mode, options) => {
      options?.onProgress?.({
        budget: {} as never,
        budgetState: {} as never,
        round: 5,
        mode: 'deep',
        sourceMap: [
          { source_index: 1, title: 'T', url: 'https://example.com', domain: 'example.com', snippet: 'key fact' },
        ],
      });
      return new Promise<never>(() => {});
    });
    mockedCallLLM.mockResolvedValue({
      model: 'm',
      provider: 'p',
      usage: { inputTokens: 0, outputTokens: 0 },
      fullContent: 'Salvaged from evidence.',
    } as never);
    const job = createResearchJob({ query: 'q', mode: 'deep', researchApi: true });

    await runResearchJob(job.id);

    const finished = getResearchJob(job.id);
    expect(finished?.status).toBe('completed');
    expect(mockedCallLLM).toHaveBeenCalledOnce();
    const result = finished?.result as { answer: string } | undefined;
    expect(result?.answer).toContain('Salvaged from evidence.');
    expect(result?.answer).toContain('Partial answer');
  }, 10_000);
});
