import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createStreamingTimeout,
  FINAL_ANSWER_TIMEOUT_MS,
  llmTotalTimeoutMs,
  materializeWithTimeout,
  retryDelaysForFinalAnswer,
} from '../src/llm.js';

describe('llm timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scales the total with context and caps it', () => {
    expect(llmTotalTimeoutMs(0)).toBe(120_000);
    /* The 377K-char final answer that died at the old 75s guillotine. */
    expect(llmTotalTimeoutMs(377_000)).toBe(195_000);
    expect(llmTotalTimeoutMs(10_000_000)).toBe(600_000);
  });

  it('budgets the forced final answer by output length, not just input', () => {
    /* j-AbdnmdUTgeLo: 405K chars in, long report out, dead at ~200s. The
       input term alone cannot cover generating the report. */
    expect(llmTotalTimeoutMs(0, 'short')).toBe(FINAL_ANSWER_TIMEOUT_MS.short);
    expect(llmTotalTimeoutMs(0, 'long')).toBe(FINAL_ANSWER_TIMEOUT_MS.long);
    expect(llmTotalTimeoutMs(0, 'exhaustive')).toBe(FINAL_ANSWER_TIMEOUT_MS.exhaustive);
    expect(llmTotalTimeoutMs(377_000, 'long')).toBe(FINAL_ANSWER_TIMEOUT_MS.long);
    /* Prefill still costs: the larger side wins either way. */
    expect(llmTotalTimeoutMs(10_000_000, 'short')).toBe(600_000);
  });

  it('gives a final-answer call one retry instead of five', () => {
    const all = [1_000, 2_000, 4_000, 6_000, 10_000];
    expect(retryDelaysForFinalAnswer(all, true)).toEqual([1_000]);
    expect(retryDelaysForFinalAnswer(all, false)).toEqual(all);
    expect(retryDelaysForFinalAnswer(all, undefined)).toEqual(all);
  });

  it('aborts a stream that never produces a chunk', () => {
    vi.useFakeTimers();
    const t = createStreamingTimeout(undefined, 1000, 100);
    let aborted = false;
    t.signal.addEventListener('abort', () => {
      aborted = true;
    });
    vi.advanceTimersByTime(1000);
    expect(aborted).toBe(true);
    t.dispose();
  });

  it('restarts the idle timer on every chunk', () => {
    vi.useFakeTimers();
    const t = createStreamingTimeout(undefined, 10_000, 100);
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

  it('does not fire after dispose', () => {
    vi.useFakeTimers();
    const t = createStreamingTimeout(undefined, 200, 100);
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
