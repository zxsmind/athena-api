import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApiPlatformStore, PUBLIC_KEY_ID_LENGTH } from '../src/api-platform-store.js';
import { Meter, utcDay } from '../src/application/meter.js';
import { resetConfigForTests } from '../src/config/load.js';
import { defaultConfig } from '../src/config/defaults.js';

let tempDir = '';
const open: ApiPlatformStore[] = [];

function newStore(): ApiPlatformStore {
  const store = new ApiPlatformStore(join(tempDir, 'keys.sqlite'));
  open.push(store);
  return store;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'athena-keys-'));
  resetConfigForTests();
});

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  rmSync(tempDir, { recursive: true, force: true });
  resetConfigForTests();
});

describe('public key ids', () => {
  it('issues a short id of the requested length', () => {
    const store = newStore();
    const { record } = store.createApiKey('first', 'free');
    expect(record.id).toHaveLength(PUBLIC_KEY_ID_LENGTH);
  });

  it('looks like a mixed-case alphanumeric code', () => {
    const store = newStore();
    const { record } = store.createApiKey('first', 'free');
    expect(record.id).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(record.id).not.toBe(record.id.toLowerCase());
  });

  it('excludes visually ambiguous characters', () => {
    const store = newStore();
    for (let i = 0; i < 40; i++) {
      const { record } = store.createApiKey(`key-${i}`, 'free');
      expect(record.id).not.toMatch(/[IOLl]/);
    }
  });

  it('never repeats an id', () => {
    const store = newStore();
    const ids = new Set<string>();
    for (let i = 0; i < 60; i++) ids.add(store.createApiKey(`key-${i}`, 'free').record.id);
    expect(ids.size).toBe(60);
  });

  it('keeps the secret out of the id', () => {
    const store = newStore();
    const { record, secret } = store.createApiKey('first', 'free');
    expect(record.id).not.toBe(secret);
    expect(secret.startsWith('ath_')).toBe(true);
  });

  it('stores only the digest of the secret', () => {
    const store = newStore();
    const { record, secret } = store.createApiKey('first', 'free');
    expect(record.secretHash).not.toBe(secret);
    expect(store.findActiveBySecret(secret)?.id).toBe(record.id);
  });

  it('stores the chosen plan', () => {
    const store = newStore();
    expect(store.createApiKey('p', 'enterprise').record.plan).toBe('enterprise');
  });

  it('defaults an unknown plan value to free when reading', () => {
    const store = newStore();
    const { record } = store.createApiKey('p', 'paid');
    store.createApiKey('q', 'free');
    const listed = store.listApiKeys();
    expect(listed.find((key) => key.id === record.id)?.plan).toBe('paid');
  });
});

describe('daily credit balance', () => {
  it('starts at zero', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'free');
    expect(meter.balanceOf(record.id, 'free').usedCredits).toBe(0);
  });

  it('accumulates charges on the same day', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'paid');
    meter.chargeSearch(record.id);
    meter.chargeSearch(record.id);
    expect(meter.balanceOf(record.id, 'paid').usedCredits).toBeCloseTo(0.014, 6);
  });

  it('keeps separate days apart', () => {
    const store = newStore();
    const { record } = store.createApiKey('k', 'paid');
    store.debitDailyCredits(record.id, '2026-01-01', 0.5);
    expect(store.creditsUsedToday(record.id, '2026-01-02')).toBe(0);
    expect(store.creditsUsedToday(record.id, '2026-01-01')).toBe(0.5);
  });

  it('computes the UTC day key', () => {
    expect(utcDay(new Date('2026-03-04T23:59:59.000Z'))).toBe('2026-03-04');
    expect(utcDay(new Date('2026-03-05T00:00:00.000Z'))).toBe('2026-03-05');
  });
});

describe('budget admission', () => {
  it('admits a request below the daily allowance', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'free');
    expect(meter.admit(record.id, 'free')).toBeNull();
  });

  it('admits at exactly the daily allowance', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'free');
    store.debitDailyCredits(record.id, utcDay(), 1);
    expect(meter.admit(record.id, 'free')).toBeNull();
  });

  it('still admits inside the overrun allowance', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'free');
    /* Free overrun is 0.25 credits. */
    store.debitDailyCredits(record.id, utcDay(), 1.1);
    expect(meter.admit(record.id, 'free')).toBeNull();
  });

  it('refuses beyond the overrun allowance', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'free');
    store.debitDailyCredits(record.id, utcDay(), 1.3);
    expect(meter.admit(record.id, 'free')?.reason).toBe('budget_exhausted');
  });

  it('reports the balance that caused the refusal', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'free');
    store.debitDailyCredits(record.id, utcDay(), 2);
    expect(meter.admit(record.id, 'free')?.balance).toEqual({
      usedCredits: 2,
      dailyCredits: defaultConfig.plans.free.dailyCredits,
      overrunCredits: defaultConfig.plans.free.overrunCredits,
    });
  });

  it('applies each plan its own allowance', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'enterprise');
    store.debitDailyCredits(record.id, utcDay(), 2);
    expect(meter.admit(record.id, 'enterprise')).toBeNull();
  });

  it('skips metering for an anonymous loopback caller', () => {
    const store = newStore();
    const meter = new Meter(store);
    expect(meter.admit(null, null)).toBeNull();
  });
});

describe('charging', () => {
  it('bills a search request', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'paid');
    meter.chargeSearch(record.id);
    expect(meter.balanceOf(record.id, 'paid').usedCredits).toBeCloseTo(0.007, 6);
  });

  it('bills only the pages that were extracted', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'paid');
    meter.chargeContents(record.id, 2);
    expect(meter.balanceOf(record.id, 'paid').usedCredits).toBeCloseTo(0.002, 6);
  });

  it('charges nothing for zero pages', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'paid');
    expect(meter.chargeContents(record.id, 0)).toBe(0);
  });

  it('charges nothing for an anonymous caller', () => {
    const store = newStore();
    const meter = new Meter(store);
    expect(meter.chargeSearch(null)).toBe(0);
    expect(meter.chargeContents(null, 5)).toBe(0);
  });

  it('bills research from the job counters and reported tokens', () => {
    const store = newStore();
    const meter = new Meter(store, () => ({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }));
    const { record } = store.createApiKey('k', 'paid');
    const snapshot = {
      used_search_calls: 4, search_calls_limit: 24,
      used_fetch_calls: 2, fetch_calls_limit: 24,
      used_tokens: 100_000, token_limit: 250_000,
      elapsed_ms: 1_000, wall_clock_limit_ms: 900_000,
      used_steps: 10, step_limit: 30,
      exhausted_by: null,
      token_ledger: {
        'acme/sonnet': {
          providerId: 'acme', modelId: 'sonnet',
          inputTokens: 60_000, outputTokens: 20_000,
          cacheReadTokens: 20_000, cacheWriteTokens: 0,
          requests: 4,
        },
      },
    };
    meter.chargeResearch(record.id, snapshot, true);
    const tokens = (60_000 * 3 + 20_000 * 15 + 20_000 * 0.3) / 1_000_000;
    const expected = 4 * defaultConfig.pricing.researchSearchCall
      + 2 * defaultConfig.pricing.researchFetchCall
      + tokens;
    expect(meter.balanceOf(record.id, 'paid').usedCredits).toBeCloseTo(expected, 6);
  });

  it('leaves tokens unbilled when the catalog has no price for the model', () => {
    const store = newStore();
    const meter = new Meter(store, () => null);
    const { record } = store.createApiKey('k', 'paid');
    const snapshot = {
      used_search_calls: 4, search_calls_limit: 24,
      used_fetch_calls: 2, fetch_calls_limit: 24,
      used_tokens: 100_000, token_limit: 250_000,
      elapsed_ms: 1_000, wall_clock_limit_ms: 900_000,
      used_steps: 10, step_limit: 30,
      exhausted_by: null,
      token_ledger: {
        'acme/unknown': {
          providerId: 'acme', modelId: 'unknown',
          inputTokens: 100_000, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          requests: 1,
        },
      },
    };
    meter.chargeResearch(record.id, snapshot, true);
    const expected = 4 * defaultConfig.pricing.researchSearchCall + 2 * defaultConfig.pricing.researchFetchCall;
    expect(meter.balanceOf(record.id, 'paid').usedCredits).toBeCloseTo(expected, 6);
  });

  it('never bills tokens the provider did not report', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'paid');
    const snapshot = {
      used_search_calls: 4, search_calls_limit: 24,
      used_fetch_calls: 2, fetch_calls_limit: 24,
      used_tokens: 100_000, token_limit: 250_000,
      elapsed_ms: 1_000, wall_clock_limit_ms: 900_000,
      used_steps: 10, step_limit: 30,
      exhausted_by: null,
    };
    meter.chargeResearch(record.id, snapshot, false);
    const expected = 4 * defaultConfig.pricing.researchSearchCall
      + 2 * defaultConfig.pricing.researchFetchCall;
    expect(meter.balanceOf(record.id, 'paid').usedCredits).toBeCloseTo(expected, 6);
  });

  it('lets a single job overspend past the daily allowance', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'free');
    const snapshot = {
      used_search_calls: 200, search_calls_limit: 200,
      used_fetch_calls: 100, fetch_calls_limit: 100,
      used_tokens: 500_000, token_limit: 250_000,
      elapsed_ms: 60_000, wall_clock_limit_ms: 900_000,
      used_steps: 30, step_limit: 30,
      exhausted_by: 'steps',
    };
    /* Billing happens after the run, so it must succeed even at a negative balance. */
    meter.chargeResearch(record.id, snapshot, true);
    expect(meter.balanceOf(record.id, 'free').usedCredits).toBeGreaterThan(1);
    expect(meter.admit(record.id, 'free')?.reason).toBe('budget_exhausted');
  });
});

describe('concurrency slots', () => {
  it('admits up to the plan limit and refuses beyond it', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'free');
    for (let i = 0; i < 5; i += 1) expect(meter.acquireJobSlot(record.id, 'free')).toBe(true);
    expect(meter.acquireJobSlot(record.id, 'free')).toBe(false);
    expect(meter.activeJobCount(record.id)).toBe(5);
  });

  it('gives a freed slot back to the same key', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'paid');
    for (let i = 0; i < 20; i += 1) expect(meter.acquireJobSlot(record.id, 'paid')).toBe(true);
    expect(meter.acquireJobSlot(record.id, 'paid')).toBe(false);
    meter.releaseJobSlot(record.id);
    expect(meter.acquireJobSlot(record.id, 'paid')).toBe(true);
  });

  it('counts each key separately', () => {
    const store = newStore();
    const meter = new Meter(store);
    const a = store.createApiKey('a', 'free').record;
    const b = store.createApiKey('b', 'free').record;
    expect(meter.acquireJobSlot(a.id, 'free')).toBe(true);
    expect(meter.acquireJobSlot(b.id, 'free')).toBe(true);
  });

  it('never limits an unmetered local request', () => {
    const store = newStore();
    const meter = new Meter(store);
    for (let i = 0; i < 50; i += 1) expect(meter.acquireJobSlot(null, null)).toBe(true);
  });

  it('does not go negative when a slot is released twice', () => {
    const store = newStore();
    const meter = new Meter(store);
    const { record } = store.createApiKey('k', 'free');
    meter.acquireJobSlot(record.id, 'free');
    meter.releaseJobSlot(record.id);
    meter.releaseJobSlot(record.id);
    expect(meter.activeJobCount(record.id)).toBe(0);
  });
});

describe('shared limiter state', () => {
  it('enforces rate limits across Meter instances on the same database', () => {
    /* Two Meters stand in for two processes serving one database file. */
    const store = newStore();
    const first = new Meter(store);
    const second = new Meter(store);
    const { record } = store.createApiKey('k', 'free');

    /* Free allows 10 per second. Spend them through the first meter. */
    for (let i = 0; i < 10; i += 1) expect(first.admit(record.id, 'free')).toBeNull();
    expect(first.admit(record.id, 'free')?.reason).toBe('rate_limit');
    /* The second meter sees the same buckets: the 11th request is refused. */
    expect(second.admit(record.id, 'free')?.reason).toBe('rate_limit');
  });

  it('shares concurrency slots across Meter instances on the same database', () => {
    const store = newStore();
    const first = new Meter(store);
    const second = new Meter(store);
    const { record } = store.createApiKey('k', 'free');

    for (let i = 0; i < 5; i += 1) expect(first.acquireJobSlot(record.id, 'free')).toBe(true);
    /* Free allows 5 concurrent jobs; the other process cannot take a sixth. */
    expect(second.acquireJobSlot(record.id, 'free')).toBe(false);
    expect(second.activeJobCount(record.id)).toBe(5);
    /* Releasing from either side frees the slot for both. */
    second.releaseJobSlot(record.id);
    expect(first.acquireJobSlot(record.id, 'free')).toBe(true);
  });
});

describe('revocation', () => {
  it('stops a revoked key from authenticating', () => {
    const store = newStore();
    const { record, secret } = store.createApiKey('k', 'free');
    expect(store.findActiveBySecret(secret)).not.toBeNull();
    store.revokeApiKey(record.id);
    expect(store.findActiveBySecret(secret)).toBeNull();
  });

  it('reports revocation only once', () => {
    const store = newStore();
    const { record } = store.createApiKey('k', 'free');
    expect(store.revokeApiKey(record.id)).toBe(true);
    expect(store.revokeApiKey(record.id)).toBe(false);
  });
});
