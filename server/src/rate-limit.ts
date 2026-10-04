import type { PlanConfig } from './config/schema.js';

/**
 * Per-key request limiting with two independent mechanisms:
 *
 * - Seconds: a token bucket, which permits short bursts up to the per-second rate.
 * - Minutes: a sliding-window counter, because "N requests per minute" is a
 *   contract on the rolling 60-second total. A token bucket would admit up to
 *   2N in the worst case (a full bucket plus a full refill inside the window),
 *   which breaks that contract.
 *
 * State is in-memory and bounded to one bucket and two counters per key. This is
 * correct for the single-process deployment the service runs in; a multi-process
 * deployment would need shared state.
 */
export interface RateDecision {
  allowed: boolean;
  /** Seconds the caller should wait before retrying. Zero when allowed. */
  retryAfterSeconds: number;
  /** Which limit refused the request, for the error body. */
  limit: 'per_second' | 'per_minute' | null;
}

const MINUTE_MS = 60_000;
export const RATE_LIMIT_IDLE_EVICTION_MS = 10 * 60 * 1000;

interface SecondBucket {
  tokens: number;
  updatedAt: number;
}

interface MinuteWindow {
  /** Index of the current fixed window: floor(now / MINUTE_MS). */
  window: number;
  /** Requests recorded in the current window. */
  count: number;
  /** Requests recorded in the previous window, used for the rolling estimate. */
  previous: number;
}

/** The persisted per-key limiter state. Plain data so any store can hold it. */
export interface RateLimitEntry {
  second: SecondBucket;
  minute: MinuteWindow;
  touchedAt: number;
}

export function emptyRateLimitEntry(perSecond: number | null, now: number): RateLimitEntry {
  return {
    second: { tokens: perSecond ?? 0, updatedAt: now },
    minute: { window: Math.floor(now / MINUTE_MS), count: 0, previous: 0 },
    touchedAt: now,
  };
}

function rollWindow(entry: RateLimitEntry, now: number): void {
  const current = Math.floor(now / MINUTE_MS);
  if (entry.minute.window === current) return;
  if (entry.minute.window === current - 1) {
    entry.minute.previous = entry.minute.count;
  } else {
    entry.minute.previous = 0;
  }
  entry.minute.count = 0;
  entry.minute.window = current;
}

/** Weighted rolling-60s total: the previous window decays linearly. */
function rollingCount(entry: RateLimitEntry, now: number): number {
  rollWindow(entry, now);
  const progress = (now % MINUTE_MS) / MINUTE_MS;
  return entry.minute.previous * (1 - progress) + entry.minute.count;
}

/**
 * The whole decision as a pure function: load an entry, call this, store the
 * returned entry. Callers that hold the entry in memory and callers that keep
 * it in SQLite share this function, so the contract cannot drift between them.
 */
export function applyRateLimit(
  existing: RateLimitEntry | undefined,
  perSecond: number | null,
  perMinute: number | null,
  now: number,
): { decision: RateDecision; entry: RateLimitEntry } {
  if (perSecond === null && perMinute === null) {
    return { decision: { allowed: true, retryAfterSeconds: 0, limit: null }, entry: existing ?? emptyRateLimitEntry(null, now) };
  }

  const entry = existing ?? emptyRateLimitEntry(perSecond, now);
  entry.touchedAt = now;

  if (perSecond !== null) {
    const elapsed = Math.max(0, now - entry.second.updatedAt);
    entry.second.tokens = Math.min(perSecond, entry.second.tokens + elapsed * (perSecond / 1000));
    entry.second.updatedAt = now;
    if (entry.second.tokens < 1) {
      const waitMs = (1 - entry.second.tokens) / (perSecond / 1000);
      return { decision: { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)), limit: 'per_second' }, entry };
    }
  }

  if (perMinute !== null) {
    const used = rollingCount(entry, now);
    if (used >= perMinute) {
      const remaining = MINUTE_MS - (now % MINUTE_MS);
      return { decision: { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)), limit: 'per_minute' }, entry };
    }
  }

  if (perSecond !== null) entry.second.tokens -= 1;
  if (perMinute !== null) entry.minute.count += 1;
  return { decision: { allowed: true, retryAfterSeconds: 0, limit: null }, entry };
}

export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Consumes one request for `keyId`. Unlimited buckets are never touched. */
  take(keyId: string, plan: PlanConfig): RateDecision {
    const now = this.now();
    const perSecond = plan.requestsPerSecond;
    const perMinute = plan.requestsPerMinute;
    if (perSecond === null && perMinute === null) {
      this.evictIdle(now);
      return { allowed: true, retryAfterSeconds: 0, limit: null };
    }

    const { decision, entry } = applyRateLimit(this.entries.get(keyId), perSecond, perMinute, now);
    this.entries.set(keyId, entry);
    this.evictIdle(now);
    return decision;
  }

  /** Drops entries that have been idle long enough to be fully reset. */
  private evictIdle(now: number): void {
    if (this.entries.size < 256) return;
    for (const [keyId, entry] of this.entries) {
      if (now - entry.touchedAt > RATE_LIMIT_IDLE_EVICTION_MS) this.entries.delete(keyId);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
