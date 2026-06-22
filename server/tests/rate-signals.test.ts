import { describe, it, expect, beforeEach } from 'vitest';
import {
  consumeRateSignalsForCooldown,
  parseRetryAfterMs,
  recordRateLimitHit,
  resetRateSignalsForTests,
} from '../src/engine/rate-signals.js';
import { computeCooldownMs, createCooldownState } from '../src/engine/cooldown.js';
import { DEFAULT_RESEARCH_DEPTH_PRESETS } from '../src/engine/depth-presets.js';

describe('rate-signals', () => {
  beforeEach(() => resetRateSignalsForTests());

  it('parses numeric retry-after seconds', () => {
    const res = new Response(null, { headers: { 'retry-after': '30' } });
    expect(parseRetryAfterMs(res)).toBe(30_000);
  });

  it('feeds retry-after into cooldown compute', () => {
    recordRateLimitHit(45_000);
    const { retryAfterMs, providerPressure } = consumeRateSignalsForCooldown();
    expect(retryAfterMs).toBe(45_000);
    expect(providerPressure).toBeGreaterThan(0);

    const preset = { ...DEFAULT_RESEARCH_DEPTH_PRESETS.med, mode: 'deep' as const };
    const { ms, reason } = computeCooldownMs({
      preset,
      state: createCooldownState(),
      remainingRounds: 5,
      retryAfterMs,
    });
    expect(ms).toBeGreaterThanOrEqual(45_000);
    expect(reason).toContain('retry-after');
  });

  it('consumes retry-after once', () => {
    recordRateLimitHit(10_000);
    consumeRateSignalsForCooldown();
    const second = consumeRateSignalsForCooldown();
    expect(second.retryAfterMs).toBeUndefined();
  });
});
