import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/engine/retry.js';
import { resetConfigForTests, getConfig, setConfig } from '../src/config/load.js';

describe('withRetry', () => {
  it('returns immediately when the call succeeds', async () => {
    const attempt = vi.fn().mockResolvedValue('ok');
    const outcome = await withRetry('web_search', [1_000, 2_000], attempt);
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toBe('ok');
    expect(outcome.attempts).toBe(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    /* A healthy run must not pay for a wait it did not need. */
    expect(outcome.waitedMs).toBe(0);
  });

  it('retries a failure and then succeeds', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('recovered');
    const outcome = await withRetry('fetch_url', [0, 0], attempt);
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toBe('recovered');
    expect(outcome.attempts).toBe(2);
  });

  it('gives up after the last delay and reports the real reason', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('provider exploded'));
    const outcome = await withRetry('web_search', [0, 0, 0], attempt);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('provider exploded');
    /* One initial try plus one per configured delay. */
    expect(attempt).toHaveBeenCalledTimes(4);
  });

  it('reports how many attempts failed, so a short answer is explainable', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('down'));
    const outcome = await withRetry('web_search', [0], attempt);
    expect(outcome.error).toBe('down');
    expect(outcome.attempts).toBe(2);
  });

  it('prefers a provider retry-after over the configured backoff', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue('ok');
    const outcome = await withRetry('web_search', [1, 2, 4], attempt, {
      /* A real 30s wait would prove nothing the reported duration does not, so
         this uses a value large enough to be distinguishable but still instant. */
      retryAfterMs: () => 12,
    });
    expect(outcome.ok).toBe(true);
    /* The upstream knows how long it needs; our 1s guess would just 429 again. */
    expect(outcome.waitedMs).toBe(12);
  });

  it('ignores a zero or missing retry-after and uses the backoff', async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue('ok');
    const outcome = await withRetry('web_search', [10], attempt, {
      retryAfterMs: () => 0,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.waitedMs).toBe(10);
  });

  it('stops on abort instead of retrying', async () => {
    const controller = new AbortController();
    const attempt = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error('cancelled'));
    });
    const outcome = await withRetry('web_search', [1_000], attempt, { signal: controller.signal });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('cancelled');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('notifies the caller before each wait, with the reason', async () => {
    const retries: { attempt: number; delayMs: number; error: string }[] = [];
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValue('ok');
    await withRetry('web_search', [7], attempt, {
      onRetry: (info) => retries.push(info),
    });
    expect(retries).toEqual([{ attempt: 1, delayMs: 7, error: 'first' }]);
  });
});

describe('retry configuration', () => {
  it('ships an increasing backoff that ends in a bounded final attempt', () => {
    resetConfigForTests();
    const delays = getConfig().research.retryDelaysMs;
    expect(delays.length).toBeGreaterThan(0);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(30_000);
  });

  it('uses the configured delays', async () => {
    resetConfigForTests();
    const base = getConfig();
    setConfig({ ...base, research: { ...base.research, retryDelaysMs: [1, 2] } });
    const attempt = vi.fn().mockRejectedValue(new Error('x'));
    const outcome = await withRetry('web_search', getConfig().research.retryDelaysMs, attempt);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(outcome.ok).toBe(false);
  });
});
