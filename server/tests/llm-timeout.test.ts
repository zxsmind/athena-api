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
  researchBudgetFits,
  resolveResearchPreset,
  responseLengthForMode,
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
  it('gives a research round the whole promise, not what is left after the answer share', () => {
    /* The clock is pinned for the reason the sibling test documents: the state
       and the call each read Date.now(), and a tick between them returns
       wall-1 where the assertion asks for wall. It failed about one run in
       three under load. */
    vi.useFakeTimers();
    try {
      const deep = resolveResearchPreset('deep');
      const state = createBudgetState();
      /* A deep run promises 90 minutes and the round runs against that promise.
         It used to be given the promise minus the answer's share, and that
         remainder is what cut a round while it was still producing. */
      expect(callDeadlineMs(state, deep, 'long', false)).toBe(deep.maxWallClockMs);
      expect(callDeadlineMs(state, deep, 'long', false)).toBeGreaterThan(4_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shrinks a round deadline as the promise is spent, but never past it', () => {
    vi.useFakeTimers();
    try {
      const preset = resolveResearchPreset('max');
      const state = createBudgetState();
      state.startedAt = Date.now() - (preset.maxWallClockMs - 60_000);
      const deadline = callDeadlineMs(state, preset, 'exhaustive', false);
      expect(deadline).toBe(60_000);
      expect(deadline).toBeLessThanOrEqual(preset.maxWallClockMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the answer by what the report needs, whatever the mode has left', () => {
    vi.useFakeTimers();
    try {
      const preset = resolveResearchPreset('default');
      const state = createBudgetState();
      /* One table, every mode: the answer no longer inherits whatever research
         left behind. That inheritance is what cut a stream that was still
         producing (job `j-xp0pLJqGQB4O`: 149.9s of uninterrupted output,
         `deadline reached`) against a share instant capped at half its promise. */
      expect(callDeadlineMs(state, preset, 'long', true)).toBe(FINAL_ANSWER_TIMEOUT_MS.long);
      state.startedAt = Date.now() - (preset.maxWallClockMs - 60_000);
      expect(callDeadlineMs(state, preset, 'long', true)).toBe(FINAL_ANSWER_TIMEOUT_MS.long);
      expect(callDeadlineMs(createBudgetState(), resolveResearchPreset('instant'), 'short', true))
        .toBe(FINAL_ANSWER_TIMEOUT_MS.short);
    } finally {
      vi.useRealTimers();
    }
  });

  it('funds the answer out of the promise outright, with no share cap', () => {
    /* The old rule capped the reserve at half the promise, which is exactly how
       instant came to set aside 150s for an answer this same table puts at
       540s: two numbers that could never agree. */
    expect(answerReserveMs('short')).toBe(FINAL_ANSWER_TIMEOUT_MS.short);
    expect(answerReserveMs('long')).toBe(FINAL_ANSWER_TIMEOUT_MS.long);
    expect(answerReserveMs('exhaustive')).toBe(FINAL_ANSWER_TIMEOUT_MS.exhaustive);
  });

  it('fixes instant to a short answer, so the pair it cannot honour is not offered', () => {
    /* instant promises five minutes in total; long and exhaustive need more of
       it than is left for research, so the mode answers at one length. */
    expect(responseLengthForMode('instant', 'long')).toBe('short');
    expect(responseLengthForMode('instant', 'exhaustive')).toBe('short');
    expect(responseLengthForMode('instant', 'short')).toBe('short');
    expect(responseLengthForMode('default', 'long')).toBe('long');
    expect(responseLengthForMode('deep', 'exhaustive')).toBe('exhaustive');
  });

  it('announces the answer window before the wall clock is actually spent', () => {
    const preset = resolveResearchPreset('default');
    const state = createBudgetState();
    expect(answerWindowReserved(state, preset, 'long')).toBe(false);
    /* Time left equals the answer's share: research stops, the answer still
       gets all of it. */
    state.startedAt = Date.now() - (preset.maxWallClockMs - answerReserveMs('long'));
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
    expect(callDeadlineMs(state, preset, 'short', false)).toBe(MIN_CALL_DEADLINE_MS);
    /* The answer is bounded by what the report needs, not by what the promise
       has left to give: the promise was spent on research, and answering late
       still beats returning nothing for it. */
    expect(callDeadlineMs(state, preset, 'short', true)).toBe(FINAL_ANSWER_TIMEOUT_MS.short);
  });

  it('leaves no research share for the pair instant cannot honour', () => {
    /* Why instant answers at one length: a long report is owed 540s out of a
       300s promise, so there would be nothing left to research with. The engine
       never sees the pair — responseLengthForMode fixes it — but the split is
       well defined either way. */
    vi.useFakeTimers();
    try {
      const instant = resolveResearchPreset('instant');
      const state = createBudgetState();
      expect(researchBudgetFits(state, instant, 'long')).toBe(false);
      expect(researchBudgetFits(state, instant, 'short')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops research when its share cannot pay for a round at the floor', () => {
    /* The failure this pins: an instant run had 19s of research time left
       against the 30s floor, round 6 was started anyway, and it was killed at
       the floor while the answer's time sat untouched. A round is only started
       while its share still covers the floor. */
    vi.useFakeTimers();
    try {
      const preset = resolveResearchPreset('instant');
      const state = createBudgetState();
      const reserve = answerReserveMs('short');
      expect(researchBudgetFits(state, preset, 'short')).toBe(true);

      state.startedAt = Date.now() - (preset.maxWallClockMs - reserve - MIN_CALL_DEADLINE_MS);
      expect(researchBudgetFits(state, preset, 'short')).toBe(true);

      state.startedAt = Date.now() - (preset.maxWallClockMs - reserve - MIN_CALL_DEADLINE_MS + 1);
      expect(researchBudgetFits(state, preset, 'short')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends research before the answer share is touched', () => {
    vi.useFakeTimers();
    try {
      const preset = resolveResearchPreset('instant');
      const state = createBudgetState();
      const reserve = answerReserveMs('short');
      state.startedAt = Date.now() - (preset.maxWallClockMs - reserve);
      /* Research is over here; the answer still gets all of its share instead
         of inheriting whatever a late round left behind. */
      expect(researchBudgetFits(state, preset, 'short')).toBe(false);
      expect(callDeadlineMs(state, preset, 'short', true)).toBeGreaterThanOrEqual(reserve);
    } finally {
      vi.useRealTimers();
    }
  });
});
