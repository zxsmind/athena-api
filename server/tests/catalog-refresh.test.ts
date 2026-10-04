import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  catalogIntervalMsFromHours,
  catalogRefreshDelayMs,
  DEFAULT_CATALOG_REFRESH_MS,
  getCatalogRefreshIntervalMs,
  getCatalogRefreshState,
  resetCatalogRefreshStateForTests,
  setCatalogRefreshIntervalMs,
  startCatalogRefresh,
  type CatalogRefreshEvent,
  type ModelsDevSnapshot,
} from '../src/models-dev.js';

const snapshotAt = (fetchedAt: string): ModelsDevSnapshot => ({ fetchedAt, providers: { acme: { id: 'acme' } } });

beforeEach(() => {
  resetCatalogRefreshStateForTests();
  setCatalogRefreshIntervalMs(DEFAULT_CATALOG_REFRESH_MS);
});

describe('default cadence', () => {
  it('is twelve hours', () => {
    expect(DEFAULT_CATALOG_REFRESH_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('converts configured hours to milliseconds', () => {
    expect(catalogIntervalMsFromHours(12)).toBe(43_200_000);
    expect(catalogIntervalMsFromHours(6)).toBe(21_600_000);
  });

  it('falls back to twelve hours for a nonsensical value', () => {
    expect(catalogIntervalMsFromHours(0)).toBe(DEFAULT_CATALOG_REFRESH_MS);
    expect(catalogIntervalMsFromHours(-4)).toBe(DEFAULT_CATALOG_REFRESH_MS);
    expect(catalogIntervalMsFromHours(Number.NaN)).toBe(DEFAULT_CATALOG_REFRESH_MS);
  });
});

describe('catalogRefreshDelayMs', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z');

  it('returns zero when nothing is cached', () => {
    expect(catalogRefreshDelayMs(null, 43_200_000, now)).toBe(0);
  });

  it('returns the remaining time for a fresh cache', () => {
    const fresh = snapshotAt(new Date(now - 1_000_000).toISOString());
    expect(catalogRefreshDelayMs(fresh, 43_200_000, now)).toBe(42_200_000);
  });

  it('returns zero for an expired cache', () => {
    const stale = snapshotAt(new Date(now - 50_000_000).toISOString());
    expect(catalogRefreshDelayMs(stale, 43_200_000, now)).toBe(0);
  });

  it('returns zero when the timestamp is unusable', () => {
    expect(catalogRefreshDelayMs(snapshotAt('not-a-date'), 43_200_000, now)).toBe(0);
  });

  it('returns zero when the clock moved backwards', () => {
    const future = snapshotAt(new Date(now + 86_400_000).toISOString());
    expect(catalogRefreshDelayMs(future, 43_200_000, now)).toBe(0);
  });
});

describe('startCatalogRefresh', () => {
  const events: CatalogRefreshEvent[] = [];
  let stop: (() => void) | null = null;

  beforeEach(() => {
    events.length = 0;
  });

  afterEach(() => {
    stop?.();
    stop = null;
  });

  it('schedules the first refresh without fetching anything', () => {
    const fetchCatalog = vi.fn();
    stop = startCatalogRefresh({ now: () => 0, fetchCatalog, onEvent: (event) => events.push(event) });
    expect(fetchCatalog).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({ type: 'scheduled' });
  });

  it('does not keep the process alive', async () => {
    stop = startCatalogRefresh({ now: () => 0, fetchCatalog: vi.fn() });
    /* An unref'd timer has no ref method callable to keep the loop alive. */
    expect(getCatalogRefreshState().nextRefreshAt).not.toBeNull();
  });

  it('refreshes, records success, and re-arms', async () => {
    vi.useFakeTimers();
    try {
      /* Stamps a fresh timestamp on every call, like the real fetcher does.
         A mock returning one fixed timestamp would make the cache look
         permanently stale and the scheduler would spin. */
      const fetchCatalog = vi.fn(async () => snapshotAt(new Date().toISOString()));
      stop = startCatalogRefresh({ fetchCatalog, onEvent: (event) => events.push(event) });

      await vi.advanceTimersByTimeAsync(43_200_000);

      expect(fetchCatalog).toHaveBeenCalledWith({ refresh: true });
      const state = getCatalogRefreshState();
      expect(state.lastSuccessAt).not.toBeNull();
      expect(state.lastError).toBeNull();
      /* Two refreshes: one immediately, because nothing was cached, and one a
         full interval later. */
      expect(events.filter((event) => event.type === 'refreshed')).toHaveLength(2);
      const scheduled = events.filter((event) => event.type === 'scheduled');
      expect(scheduled).toHaveLength(3);
      expect(scheduled[0]).toMatchObject({ delayMs: 0 });
      expect(scheduled[1]).toMatchObject({ delayMs: 43_200_000 });
      expect(scheduled[2]).toMatchObject({ delayMs: 43_200_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the error and backs off when nothing is cached', async () => {
    vi.useFakeTimers();
    try {
      const fetchCatalog = vi.fn().mockRejectedValue(new Error('network down'));
      stop = startCatalogRefresh({ fetchCatalog, onEvent: (event) => events.push(event) });

      await vi.advanceTimersByTimeAsync(0);

      const state = getCatalogRefreshState();
      expect(state.lastError).toBe('network down');
      expect(state.lastSuccessAt).toBeNull();
      expect(events.some((event) => event.type === 'failed' && event.reason === 'network down')).toBe(true);
      /* Backs off instead of retrying immediately, so an unreachable
         models.dev cannot turn into a hot loop. */
      const scheduled = events.filter((event) => event.type === 'scheduled');
      expect(scheduled).toHaveLength(2);
      expect(scheduled[1]).toMatchObject({ delayMs: 300_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a custom retry delay', async () => {
    vi.useFakeTimers();
    try {
      const fetchCatalog = vi.fn().mockRejectedValue(new Error('down'));
      stop = startCatalogRefresh({ fetchCatalog, retryDelayMs: 60_000 });
      await vi.advanceTimersByTimeAsync(0);
      const scheduled = getCatalogRefreshState();
      expect(scheduled.nextRefreshAt).not.toBeNull();
      expect(fetchCatalog).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops cleanly and cancels the pending timer', async () => {
    vi.useFakeTimers();
    try {
      const fetchCatalog = vi.fn();
      const cancel = startCatalogRefresh({ fetchCatalog });
      cancel();
      await vi.runAllTimersAsync();
      expect(fetchCatalog).not.toHaveBeenCalled();
      expect(getCatalogRefreshState().nextRefreshAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the default when given a bad interval', () => {
    stop = startCatalogRefresh({ intervalMs: 0, now: () => 0, fetchCatalog: vi.fn() });
    const state = getCatalogRefreshState();
    /* No cache yet, so the delay is zero, but the scheduler still armed. */
    expect(state.nextRefreshAt).not.toBeNull();
  });
});

describe('process-wide interval', () => {
  it('round-trips the configured value', () => {
    setCatalogRefreshIntervalMs(3_600_000);
    expect(getCatalogRefreshIntervalMs()).toBe(3_600_000);
  });

  it('ignores a non-positive value', () => {
    setCatalogRefreshIntervalMs(43_200_000);
    setCatalogRefreshIntervalMs(0);
    expect(getCatalogRefreshIntervalMs()).toBe(43_200_000);
  });
});
