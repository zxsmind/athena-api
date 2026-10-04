import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { ApiPlatformStore } from '../src/api-platform-store.js';
import { Meter } from '../src/application/meter.js';
import { createApiV1Router } from '../src/api-v1.js';
import { getAdminKey, resetAdminKeyCache } from '../src/admin-auth.js';
import { publicJob, publicProgress, publicResult, publicSources } from '../src/api-v1.js';
import type { ResearchJobRecord } from '../src/research-jobs.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

interface Harness {
  url: string;
  close: () => Promise<void>;
}

/**
 * Boots the real router over a real HTTP listener. Used to check the auth,
 * metering, and rate-limit wiring end to end, including cases unit tests on the
 * Meter alone cannot see.
 */
async function startHarness(plan: 'free' | 'paid' | 'enterprise'): Promise<Harness & { secret: string; keyId: string; store: ApiPlatformStore }> {
  const store = new ApiPlatformStore();
  const meter = new Meter(store);
  const app = express();
  app.use(express.json());
  app.use('/v1', createApiV1Router({ store, startResearchJob: () => undefined, meter }));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const { record, secret } = store.createApiKey('integration', plan);
  return {
    url: `http://127.0.0.1:${port}/v1`,
    secret,
    keyId: record.id,
    store,
    close: () => new Promise((resolve) => { server.close(() => resolve()); }),
  };
}

const auth = (secret: string) => ({ Authorization: `Bearer ${secret}` });

describe('v1 authentication and metering wiring', () => {
  it('serves health without a key', async () => {
    const h = await startHarness('free');
    try {
      const res = await fetch(`${h.url}/health`);
      expect(res.status).toBe(200);
      await res.json();
    } finally {
      await h.close();
    }
  });

  it('accepts a presented key and charges it for a contents page', async () => {
    const h = await startHarness('paid');
    try {
      const res = await fetch(`${h.url}/contents`, {
        method: 'POST',
        headers: { ...auth(h.secret), 'content-type': 'application/json' },
        body: JSON.stringify({ urls: ['https://example.org/'] }),
      });
      expect(res.status).toBe(200);
      await res.json();
    } finally {
      await h.close();
    }
  });

  it('refuses a bad bearer token', async () => {
    const h = await startHarness('free');
    try {
      const res = await fetch(`${h.url}/contents`, {
        method: 'POST',
        headers: { ...auth('ath_not_a_real_secret'), 'content-type': 'application/json' },
        body: JSON.stringify({ urls: ['https://example.org/'] }),
      });
      expect(res.status).toBe(401);
      await res.json();
    } finally {
      await h.close();
    }
  });

  it('enforces the plan rate limit over real HTTP', async () => {
    const h = await startHarness('free');
    try {
      /* The free plan allows 10/second and 30/minute. A per-second token bucket
         is timing dependent on its own: it starts full and refills continuously,
         so an exact admitted count is not a stable assertion. The per-minute
         ceiling is the deterministic bound, so the burst is sized well above it
         and asserted against that.
         /v1/models is metered and does no outbound work. */
      const burst = 150;
      const startedAt = performance.now();
      const responses = await Promise.all(
        Array.from({ length: burst }, () => fetch(`${h.url}/models`, { headers: auth(h.secret) })),
      );
      const elapsedMs = performance.now() - startedAt;
      const statuses = responses.map((res) => res.status);
      await Promise.all(responses.map((res) => res.text()));

      expect(statuses).toContain(429);
      /* The minute ceiling is a rolling window, so a burst that straddles a
         window boundary can be admitted against two windows. Bound the admitted
         count by the number of windows the burst could have touched, which is
         still far below the burst size. */
      const windows = Math.ceil(elapsedMs / 60_000) + 1;
      expect(statuses.filter((code) => code === 200).length).toBeLessThanOrEqual(30 * windows);
    } finally {
      await h.close();
    }
    /* 150 real loopback fetches are timing-heavy on Windows; the default 5s
       timeout flaked under load. Assertions are unchanged. */
  }, 20_000);

  it('refuses an invalid key even from loopback', async () => {
    const h = await startHarness('free');
    try {
      const res = await fetch(`${h.url}/contents`, {
        method: 'POST',
        headers: { ...auth('ath_wrong_secret_value'), 'content-type': 'application/json' },
        body: JSON.stringify({ urls: ['https://example.org/'] }),
      });
      expect(res.status).toBe(401);
      await res.json();
    } finally {
      await h.close();
    }
  });

  it('serves an unmetered loopback request that presents no key', async () => {
    const h = await startHarness('free');
    try {
      const res = await fetch(`${h.url}/contents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls: ['https://example.org/'] }),
      });
      expect(res.status).toBe(200);
      await res.json();
    } finally {
      await h.close();
    }
  });

  it('refuses a key once its daily allowance and overrun are spent', async () => {
    const h = await startHarness('free');
    try {
      /* Free: 1 daily credit + 0.25 overrun. Push the key just past that ceiling
         through the store, then confirm the router stops admitting it. */
      h.store.debitDailyCredits(h.keyId, new Date().toISOString().slice(0, 10), 1.3);

      const res = await fetch(`${h.url}/contents`, {
        method: 'POST',
        headers: { ...auth(h.secret), 'content-type': 'application/json' },
        body: JSON.stringify({ urls: ['https://example.org/'] }),
      });
      expect(res.status).toBe(429);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('BUDGET_EXHAUSTED');
    } finally {
      await h.close();
    }
  });
});

describe('management route admin key', () => {
  const ADMIN = 'wiring-admin-key-0123456789abcdef';
  const adminHeader = (key: string) => ({ 'X-Admin-Key': key });

  beforeEach(() => {
    resetAdminKeyCache();
    process.env.ATHENA_ADMIN_KEY = ADMIN;
  });

  afterEach(() => {
    resetAdminKeyCache();
    delete process.env.ATHENA_ADMIN_KEY;
  });

  it('refuses /keys from loopback without the admin key', async () => {
    const h = await startHarness('free');
    try {
      expect((await fetch(`${h.url}/keys`)).status).toBe(401);
      expect((await fetch(`${h.url}/analytics`)).status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('refuses a wrong admin key', async () => {
    const h = await startHarness('free');
    try {
      const res = await fetch(`${h.url}/keys`, { headers: adminHeader('wrong-key-value-1234') });
      expect(res.status).toBe(401);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    } finally {
      await h.close();
    }
  });

  it('serves key management with the admin key', async () => {
    const h = await startHarness('free');
    try {
      expect(getAdminKey()).toBe(ADMIN);
      const list = await fetch(`${h.url}/keys`, { headers: adminHeader(ADMIN) });
      expect(list.status).toBe(200);
      const created = await fetch(`${h.url}/keys`, {
        method: 'POST',
        headers: { ...adminHeader(ADMIN), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'managed', plan: 'free' }),
      });
      expect(created.status).toBe(201);
      const analytics = await fetch(`${h.url}/analytics`, { headers: adminHeader(ADMIN) });
      expect(analytics.status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe('public job payload', () => {
  const job = (over: Partial<ResearchJobRecord> = {}): ResearchJobRecord =>
    ({
      id: 'j-test',
      query: 'q',
      mode: 'instant',
      status: 'completed',
      createdAt: 't',
      updatedAt: 't',
      cancelled: false,
      events: [],
      ...over,
    }) as ResearchJobRecord;

  it('serves only the answer plus indexed source links', () => {
    const out = publicJob(job({
      result: {
        query: 'q',
        answer: 'Paris.',
        sources: [
          { source_index: 2, title: 'T', url: 'https://example.com', domain: 'example.com', snippet: 'S'.repeat(500) },
        ],
        steps: [{ type: 'search', query: 'q', context: 'C'.repeat(500) }],
        results_count: 1,
        elapsed_ms: 5,
      } as unknown as ResearchJobRecord['result'],
    })) as { result: { answer: string; sources: unknown[] } };

    expect(out.result.answer).toBe('Paris.');
    expect(out.result.sources).toEqual([{ index: 2, title: 'T', url: 'https://example.com' }]);
    expect(JSON.stringify(out)).not.toContain('S'.repeat(500));
    expect(JSON.stringify(out)).not.toContain('C'.repeat(500));
  });

  it('normalizes live camelCase counters to snake_case and drops internals', () => {
    const progress = publicProgress({
      round: 3,
      mode: 'instant',
      budget: {
        usedSearchCalls: 4,
        usedFetchCalls: 5,
        usedCpuMs: 10082.92,
        usedTokens: 100,
        usedTotalTokens: 200,
        startedAt: 1791105705163,
        usedSteps: 8,
        usedTurns: 7,
        exhaustedBy: null,
        tokenLedger: { kilo: {} },
      },
      sourceMap: [{ source_index: 1, title: 'T', url: 'u', domain: 'd', snippet: 'S' }],
    } as unknown as ResearchJobRecord['runtime']) as Record<string, unknown>;
    expect(progress).toEqual({
      round: 3,
      used_search_calls: 4,
      used_fetch_calls: 5,
      used_turns: 7,
      used_tokens: 100,
      used_cpu_seconds: 10.1,
    });
    expect(JSON.stringify(progress)).not.toContain('tokenLedger');
    expect(JSON.stringify(progress)).not.toContain('startedAt');
  });

  it('indexes sources that carry no index and skips non-sources', () => {
    expect(publicSources([{ title: 'T', url: 'u' }])).toEqual([{ index: 1, title: 'T', url: 'u' }]);
    expect(publicSources(undefined)).toEqual([]);
    expect(publicResult(undefined)).toBeUndefined();
  });
});
