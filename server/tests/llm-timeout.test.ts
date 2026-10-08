import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createStreamingTimeout,
  materializeWithTimeout,
  retryDelaysForFinalAnswer,
} from '../src/llm.js';
import {
  answerReserveMs,
  answerWindowReserved,
  callDeadlineMs,
  createBudgetState,
  FINAL_ANSWER_TIMEOUT_MS,
  MIN_CALL_DEADLINE_MS,
  resolveResearchPreset,
  elapsedMs,
} from '../src/engine/modes.js';

describe('llm timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a final-answer call one retry instead of five', () => {
    const all = [1_000, 2_000, 4_000, 6_000, 10_000];
    expect(retryDelaysForFinalAnswer(all, true)).toEqual([1_000]);
    expect(retryDelaysForFinalAnswer(all, false)).toEqual(all);
    expect(retryDelaysForFinalAnswer(all, undefined)).toEqual(all);
  });

  it('aborts a stream that never produces a chunk', () => {
    vi.useFakeTimers();
    const t = createStreamingTimeout(undefined, 100);
    let aborted = false;
    t.signal.addEventListener('abort', () => {
      aborted = true;
    });
    vi.advanceTimersByTime(100);
    expect(aborted).toBe(true);
    t.dispose();
  });

  it('restarts the idle timer on every chunk', () => {
    vi.useFakeTimers();
    const t = createStreamingTimeout(undefined, 100);
    let aborted = false;
    t.signal.addEventListener('abort', () => {
      aborted = true;
    });
    vi.advanceTimersByTime(80);
    t.chunk();
    vi.advanceTimersByTime(80);
    expect(aborted).toBe(false);
    vi.advanceTimersByTime(30);
    expect(aborted).toBe(true);
    t.dispose();
  });

  it('never fires on a stream that keeps flowing, however long', () => {
    /* The bug this replaced: a total deadline guessed how long a round may take
       and cut reasoning that was still arriving. Only silence ends a stream now,
       so a slow model is never mistaken for a dead one. */
    vi.useFakeTimers();
    const t = createStreamingTimeout(undefined, 100);
    let aborted = false;
    t.signal.addEventListener('abort', () => {
      aborted = true;
    });
    for (let elapsed = 0; elapsed < 3_600_000; elapsed += 50) {
      t.chunk();
      vi.advanceTimersByTime(50);
    }
    expect(aborted).toBe(false);
    t.dispose();
  });

  it('does not fire after dispose', () => {
    vi.useFakeTimers();
    const t = createStreamingTimeout(undefined, 100);
    let aborted = false;
    t.signal.addEventListener('abort', () => {
      aborted = true;
    });
    t.chunk();
    t.dispose();
    vi.advanceTimersByTime(10_000);
    expect(aborted).toBe(false);
  });

  it('passes through a settled materialization', async () => {
    await expect(materializeWithTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('rejects a materialization that never settles', async () => {
    await expect(materializeWithTimeout(new Promise<never>(() => {}), 50)).rejects.toThrow(
      /materialization timed out/,
    );
  });
});

describe('call deadlines come from the job budget', () => {
  it('spends the mode promise across the run instead of a fixed per-round limit', () => {
    const deep = resolveResearchPreset('deep');
    const state = createBudgetState();
    /* A deep run promises 90 minutes. The first round must not be cut at the
       ~120s that used to be a constant, and it must leave room to write. */
    const firstRound = callDeadlineMs(state, deep, 'long', false);
    expect(firstRound).toBe(deep.maxWallClockMs - answerReserveMs(deep, 'long'));
    expect(firstRound).toBeGreaterThan(4_000_000);
  });

  it('keeps the answer window out of a research round', () => {
    const preset = resolveResearchPreset('default');
    const state = createBudgetState();
    const reserve = answerReserveMs(preset, 'long');
    expect(reserve).toBe(FINAL_ANSWER_TIMEOUT_MS.long);
    /* The answer is the last call, so it gets everything that is left; a round
       gets what is left once the reserve is set aside. */
    expect(callDeadlineMs(state, preset, 'long', true)).toBe(preset.maxWallClockMs);
    expect(callDeadlineMs(state, preset, 'long', false)).toBe(preset.maxWallClockMs - reserve);
  });

  it('never reserves more than half of what the mode promised', () => {
    /* An instant run promises five minutes in total. Reserving the four or nine
       minutes a long or exhaustive report asks for would leave nothing to
       research with, so even a short answer is capped at half the promise. */
    const instant = resolveResearchPreset('instant');
    expect(answerReserveMs(instant, 'exhaustive')).toBe(Math.floor(instant.maxWallClockMs / 2));
    expect(answerReserveMs(instant, 'short')).toBe(Math.floor(instant.maxWallClockMs / 2));
    /* A mode with room to spare still reserves what its answer needs. */
    const max = resolveResearchPreset('max');
    expect(answerReserveMs(max, 'exhaustive')).toBe(FINAL_ANSWER_TIMEOUT_MS.exhaustive);
  });

  it('announces the answer window before the wall clock is actually spent', () => {
    const preset = resolveResearchPreset('default');
    const state = createBudgetState();
    expect(answerWindowReserved(state, preset, 'long')).toBe(false);
    /* Time left equals the reserve: research stops, the answer still gets room. */
    state.startedAt = Date.now() - (preset.maxWallClockMs - answerReserveMs(preset, 'long'));
    expect(answerWindowReserved(state, preset, 'long')).toBe(true);
    expect(callDeadlineMs(state, preset, 'long', true)).toBeGreaterThan(0);
  });

  it('gives a spent budget the floor rather than nothing', () => {
    const preset = resolveResearchPreset('instant');
    const state = createBudgetState();
    state.startedAt = Date.now() - preset.maxWallClockMs - 10_000;
    expect(elapsedMs(state)).toBeGreaterThan(preset.maxWallClockMs);
    /* A call with no time left would abort before the provider was asked, which
       loses an answer the evidence already supports. */
    expect(callDeadlineMs(state, preset, 'short', true)).toBe(MIN_CALL_DEADLINE_MS);
    expect(callDeadlineMs(state, preset, 'short', false)).toBe(MIN_CALL_DEADLINE_MS);
  });

  it('runs out of round time before the job promise, not after', () => {
    const preset = resolveResearchPreset('max');
    const state = createBudgetState();
    const reserve = answerReserveMs(preset, 'exhaustive');
    state.startedAt = Date.now() - (preset.maxWallClockMs - reserve - 60_000);
    const deadline = callDeadlineMs(state, preset, 'exhaustive', false);
    expect(deadline).toBeLessThanOrEqual(60_000 + MIN_CALL_DEADLINE_MS);
    /* The round stops before the reserve is touched, so the answer's window is
       still intact when the forced answer runs. */
    expect(deadline + reserve).toBeLessThanOrEqual(preset.maxWallClockMs);
  });
});
