import { describe, expect, it } from 'vitest';
import {
  contentsCharge,
  researchCharge,
  roundCredits,
  searchCharge,
} from '../src/engine/metering.js';
import { defaultConfig } from '../src/config/defaults.js';

const pricing = defaultConfig.pricing;

describe('pricing rates', () => {
  it('matches the agreed rates', () => {
    expect(pricing.searchRequest).toBe(0.007);
    expect(pricing.contentsPage).toBe(0.001);
  });

  it('prices one search request', () => {
    expect(searchCharge(pricing).total).toBe(0.007);
  });

  it('prices contents per page', () => {
    expect(contentsCharge(pricing, 1).total).toBe(0.001);
    expect(contentsCharge(pricing, 20).total).toBe(0.02);
  });

  it('never charges for zero or negative pages', () => {
    expect(contentsCharge(pricing, 0).total).toBe(0);
    expect(contentsCharge(pricing, -3).total).toBe(0);
  });

  it('reports how many pages a contents charge covers', () => {
    expect(contentsCharge(pricing, 3).lines[0]).toMatchObject({ reason: 'contents_page', units: 3, credits: 0.003 });
  });
});

describe('research charge', () => {
  const snapshot = { used_search_calls: 4, used_fetch_calls: 2, used_cpu_seconds: 30, used_tokens: 100_000 };

  /** Per-million-token prices used to check the arithmetic. */
  const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const ledger = {
    'acme/sonnet': {
      providerId: 'acme',
      modelId: 'sonnet',
      inputTokens: 60_000,
      outputTokens: 20_000,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 0,
      requests: 4,
    },
  };
  const priceOf = (providerId: string, modelId: string) =>
    providerId === 'acme' && modelId === 'sonnet' ? price : null;

  it('bills searches, page reads, execution time, and reported tokens', () => {
    const charge = researchCharge(pricing, { ...snapshot, token_ledger: ledger }, true, priceOf);
    const expectedTokens = (60_000 * 3 + 20_000 * 15 + 20_000 * 0.3) / 1_000_000;
    const expected = 4 * pricing.researchSearchCall + 2 * pricing.researchFetchCall + 30 * pricing.researchCpuSecond + expectedTokens;
    expect(charge.total).toBeCloseTo(expected, 12);
  });

  it('bills execution seconds at the configured rate', () => {
    const charge = researchCharge(pricing, { ...snapshot, used_cpu_seconds: 600, token_ledger: {} }, false);
    const cpuLine = charge.lines.find((line) => line.reason === 'research_cpu_seconds');
    expect(cpuLine).toMatchObject({ units: 600, credits: 600 * pricing.researchCpuSecond });
  });

  it('prices each model at its own rate', () => {
    const twoModels = {
      'acme/cheap': { ...ledger['acme/sonnet'], modelId: 'cheap' },
      'acme/rich': { ...ledger['acme/sonnet'], modelId: 'rich' },
    };
    const charge = researchCharge(pricing, { ...snapshot, token_ledger: twoModels }, true, (_p, modelId) =>
      modelId === 'cheap' ? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } : price,
    );
    const cheap = (60_000 * 1 + 20_000 * 1 + 20_000 * 0) / 1_000_000;
    const rich = (60_000 * 3 + 20_000 * 15 + 20_000 * 0.3) / 1_000_000;
    const work = 4 * pricing.researchSearchCall + 2 * pricing.researchFetchCall + 30 * pricing.researchCpuSecond;
    expect(charge.total).toBeCloseTo(cheap + rich + work, 12);
  });

  it('leaves a model without a catalog price unbilled and names it', () => {
    const charge = researchCharge(pricing, { ...snapshot, token_ledger: ledger }, true, () => null);
    expect(charge.total).toBeCloseTo(4 * pricing.researchSearchCall + 2 * pricing.researchFetchCall + 30 * pricing.researchCpuSecond, 12);
    expect(charge.unpricedModels).toEqual(['acme/sonnet']);
    expect(charge.unpriced).toContain('research_token');
  });

  it('never divides by anything but the catalog per-million unit', () => {
    const charge = researchCharge(pricing, { ...snapshot, token_ledger: ledger }, true, priceOf);
    const tokenLine = charge.lines.find((line) => line.reason === 'research_token');
    /* A per-million price must not be applied per token. */
    expect(tokenLine?.credits).toBeLessThan(1);
  });

  it('produces one line per reason', () => {
    expect(researchCharge(pricing, { ...snapshot, token_ledger: ledger }, true, priceOf).lines.map((line) => line.reason))
      .toEqual(['research_search_call', 'research_fetch_call', 'research_cpu_seconds', 'research_token']);
  });

  it('charges no tokens when the provider reported no usage', () => {
    const charge = researchCharge(pricing, snapshot, false);
    const tokenLine = charge.lines.find((line) => line.reason === 'research_token');
    expect(tokenLine?.units).toBe(0);
    expect(tokenLine?.credits).toBe(0);
  });

  it('is zero for a job that did no work', () => {
    const charge = researchCharge(pricing, { used_search_calls: 0, used_fetch_calls: 0, used_tokens: 0 }, true);
    expect(charge.total).toBe(0);
  });
});

describe('user scenario', () => {
  it('charges 4 searches plus 3 content pages', () => {
    const total = roundCredits(
      searchCharge(pricing).total * 4 + contentsCharge(pricing, 3).total,
    );
    expect(total).toBe(0.031);
  });

  it('does not double-count pages when charging several contents calls', () => {
    /* contentsCharge already multiplies by page count. */
    const perCall = contentsCharge(pricing, 1).total;
    const threeCalls = contentsCharge(pricing, 3).total;
    expect(threeCalls).toBe(perCall * 3);
    expect(threeCalls).not.toBe(perCall * 9);
  });

  it('stays a small share of the free daily budget', () => {
    const total = roundCredits(searchCharge(pricing).total * 4 + contentsCharge(pricing, 3).total);
    const share = total / defaultConfig.plans.free.dailyCredits;
    expect(share).toBeLessThan(0.05);
  });
});

describe('rounding', () => {
  it('keeps micro-credit precision', () => {
    expect(roundCredits(0.123456789)).toBe(0.123457);
  });

  it('leaves exact values untouched', () => {
    expect(roundCredits(0.007)).toBe(0.007);
    expect(roundCredits(0)).toBe(0);
  });
});

describe('plan presets', () => {
  it('ships the agreed daily budgets and overruns', () => {
    expect(defaultConfig.plans.free.dailyCredits).toBe(1);
    expect(defaultConfig.plans.paid.dailyCredits).toBe(50);
    expect(defaultConfig.plans.enterprise.dailyCredits).toBe(500);
    expect(defaultConfig.plans.free.overrunCredits).toBe(0.25);
    expect(defaultConfig.plans.paid.overrunCredits).toBe(1);
    expect(defaultConfig.plans.enterprise.overrunCredits).toBe(5);
  });

  it('ships the agreed rate limits', () => {
    expect(defaultConfig.plans.free.requestsPerSecond).toBe(10);
    expect(defaultConfig.plans.free.requestsPerMinute).toBe(30);
    expect(defaultConfig.plans.paid.requestsPerSecond).toBe(60);
    expect(defaultConfig.plans.paid.requestsPerMinute).toBe(200);
  });

  it('leaves enterprise unlimited', () => {
    expect(defaultConfig.plans.enterprise.requestsPerSecond).toBeNull();
    expect(defaultConfig.plans.enterprise.requestsPerMinute).toBeNull();
  });

  it('orders plans from cheapest to most generous', () => {
    const { free, paid, enterprise } = defaultConfig.plans;
    expect(free.dailyCredits).toBeLessThan(paid.dailyCredits);
    expect(paid.dailyCredits).toBeLessThan(enterprise.dailyCredits);
    expect(free.overrunCredits).toBeLessThan(paid.overrunCredits);
    expect(paid.overrunCredits).toBeLessThan(enterprise.overrunCredits);
  });
});
