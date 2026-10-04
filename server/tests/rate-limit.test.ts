import { describe, expect, it, beforeEach } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';
import { defaultConfig } from '../src/config/defaults.js';
import type { PlanConfig } from '../src/config/schema.js';

const FREE = defaultConfig.plans.free;
const PAID = defaultConfig.plans.paid;
const ENTERPRISE = defaultConfig.plans.enterprise;

/** A controllable clock: every read advances by the given number of milliseconds. */
function clock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => current, advance: (ms: number) => { current += ms; } };
}

describe('rate limiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('allows a burst up to the per-second rate', () => {
    for (let i = 0; i < 10; i++) {
      expect(limiter.take('k1', FREE).allowed).toBe(true);
    }
    expect(limiter.take('k1', FREE).allowed).toBe(false);
  });

  it('names the limit that refused the request', () => {
    for (let i = 0; i < 10; i++) limiter.take('k1', FREE);
    expect(limiter.take('k1', FREE).limit).toBe('per_second');
  });

  it('sets a retry hint when refusing', () => {
    for (let i = 0; i < 10; i++) limiter.take('k1', FREE);
    expect(limiter.take('k1', FREE).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refills over time', () => {
    const time = clock(0);
    const timed = new RateLimiter(time.now);
    for (let i = 0; i < 10; i++) timed.take('k1', FREE);
    expect(timed.take('k1', FREE).allowed).toBe(false);
    time.advance(1_000);
    expect(timed.take('k1', FREE).allowed).toBe(true);
  });

  it('sustains the per-minute rate over a long window', () => {
    /* 30 per minute sustained over five minutes is ~150 requests, plus the
       initial bucket. The minute limit must cap the sustained rate, not the
       lifetime total. */
    const time = clock(0);
    const timed = new RateLimiter(time.now);
    let allowed = 0;
    const minutes = 5;
    for (let tick = 0; tick < minutes * 600; tick++) {
      for (let i = 0; i < 10; i++) {
        if (timed.take('k1', FREE).allowed) allowed++;
      }
      time.advance(100);
    }
    const ceiling = FREE.requestsPerMinute as number;
    expect(allowed).toBeLessThanOrEqual(ceiling * minutes + ceiling);
    expect(allowed).toBeGreaterThan(ceiling * (minutes - 1));
  });

  it('caps a one-minute burst at the minute limit', () => {
    const time = clock(0);
    const timed = new RateLimiter(time.now);
    let allowed = 0;
    for (let tick = 0; tick < 600; tick++) {
      for (let i = 0; i < 10; i++) {
        if (timed.take('k1', FREE).allowed) allowed++;
      }
      time.advance(100);
    }
    expect(allowed).toBeLessThanOrEqual((FREE.requestsPerMinute as number) + 1);
  });

  it('keeps buckets separate per key', () => {
    for (let i = 0; i < 10; i++) limiter.take('a', FREE);
    expect(limiter.take('a', FREE).allowed).toBe(false);
    expect(limiter.take('b', FREE).allowed).toBe(true);
  });

  it('gives a higher plan a larger burst allowance', () => {
    for (let i = 0; i < 10; i++) expect(limiter.take('paid', PAID).allowed).toBe(true);
    expect(limiter.take('paid', PAID).allowed).toBe(true);
    for (let i = 0; i < 10; i++) limiter.take('free', FREE);
    expect(limiter.take('free', FREE).allowed).toBe(false);
  });

  it('does not refill a drained bucket just because the plan changed', () => {
    /* Raising a plan mid-window must not hand out tokens the key never earned. */
    for (let i = 0; i < 10; i++) limiter.take('k1', FREE);
    expect(limiter.take('k1', PAID).allowed).toBe(false);
  });

  it('never refuses an unlimited plan', () => {
    for (let i = 0; i < 5_000; i++) {
      expect(limiter.take('big', ENTERPRISE).allowed).toBe(true);
    }
  });

  it('treats a null rate as unlimited on that bucket only', () => {
    const secondOnly: PlanConfig = { ...FREE, requestsPerSecond: null };
    const minuteOnly = FREE.requestsPerMinute as number;
    let allowed = 0;
    for (let i = 0; i < minuteOnly + 50; i++) {
      if (limiter.take('s', secondOnly).allowed) allowed++;
    }
    expect(allowed).toBe(minuteOnly);
    expect(limiter.take('s', secondOnly).limit).toBe('per_minute');
  });

  it('starts clean after clear()', () => {
    for (let i = 0; i < 10; i++) limiter.take('k1', FREE);
    limiter.clear();
    expect(limiter.take('k1', FREE).allowed).toBe(true);
  });
});
