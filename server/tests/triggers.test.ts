import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('offload triggers', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function setup() {
    return import('../src/engine/triggers.js');
  }

  it('resolves the smallest window among the models that might serve', async () => {
    vi.doMock('../src/models-dev.js', () => ({
      getCachedModelsDevModel: (provider: string) => (provider === 'a' ? { limit: { context: 100_000 } } : undefined),
      findModelWindowAcrossProviders: () => 200_000,
    }));
    const { resolveContextWindow } = await setup();
    expect(resolveContextWindow({ providerId: 'a', model: 'm' }, { providerId: 'b', model: 'm' })).toBe(100_000);
  });

  it('falls back to the only configured provider, because the route section is empty by default', async () => {
    /* `modelRouting.deep.primary` is empty on any install that never filled it
       in, which is the default. Without a fallback the window resolved to null
       and every run traced `skipped / unknown window`, so no trigger could ever
       fire: offload was inert and silent. */
    vi.doMock('../src/settings-store.js', () => ({
      loadSettings: () => ({
        modelRouting: { deep: { primary: { providerId: '', model: '' } } },
        providers: { sovinfra: { enabled: true, models: ['qwen3.8-27b'], keys: [] } },
      }),
    }));
    vi.doMock('../src/models-dev.js', () => ({
      getCachedModelsDevModel: () => undefined,
      findModelWindowAcrossProviders: () => 262_144,
    }));
    const { researchRoutePrimary } = await setup();
    expect(researchRoutePrimary()).toEqual({ providerId: 'sovinfra', model: 'qwen3.8-27b' });
  });

  it('prefers the route for the mode being run, since routes are per mode', async () => {
    vi.doMock('../src/settings-store.js', () => ({
      loadSettings: () => ({
        modelRouting: {
          instant: { primary: { providerId: 'quick', model: 'quick-model' } },
          deep: { primary: { providerId: 'routed', model: 'routed-model' } },
        },
        providers: { sovinfra: { enabled: true, models: ['qwen3.8-27b'], keys: [] } },
      }),
    }));
    const { researchRoutePrimary } = await setup();
    expect(researchRoutePrimary('deep')).toEqual({ providerId: 'routed', model: 'routed-model' });
    expect(researchRoutePrimary('instant')).toEqual({ providerId: 'quick', model: 'quick-model' });
  });

  it('refuses to guess when several providers are configured, because the choice is the route’s', async () => {
    vi.doMock('../src/settings-store.js', () => ({
      loadSettings: () => ({
        modelRouting: { deep: { primary: { providerId: '', model: '' } } },
        providers: {
          sovinfra: { enabled: true, models: ['qwen3.8-27b'], keys: [] },
          other: { enabled: true, models: ['other-model'], keys: [] },
        },
      }),
    }));
    const { researchRoutePrimary } = await setup();
    expect(researchRoutePrimary()).toBeNull();
  });

  it('returns null when nothing resolves, so there are no ratio triggers', async () => {
    vi.doMock('../src/settings-store.js', () => ({ loadSettings: () => ({ modelRouting: {}, providers: {} }) }));
    vi.doMock('../src/models-dev.js', () => ({
      getCachedModelsDevModel: () => undefined,
      findModelWindowAcrossProviders: () => null,
    }));
    const { resolveContextWindow } = await setup();
    expect(resolveContextWindow(null, null)).toBeNull();
    expect(resolveContextWindow(
      { providerId: 'nope', model: 'missing' },
      { providerId: '', model: '' },
    )).toBeNull();
  });

  it('fires soft on the absolute trigger and hard on the window margin', async () => {
    const { compactionTier } = await setup();
    /* 262K window, 60K trigger: soft is the absolute, hard is the 90% margin. */
    expect(compactionTier(59_999, 60_000, 262_144, 'deep')).toBe('none');
    expect(compactionTier(60_000, 60_000, 262_144, 'deep')).toBe('soft');
    expect(compactionTier(235_930, 300_000, 262_144, 'deep')).toBe('hard');
  });

  it('never compacts instant, and never without a trigger', async () => {
    const { compactionTier } = await setup();
    expect(compactionTier(500_000, 60_000, 262_144, 'instant')).toBe('none');
    expect(compactionTier(500_000, 0, 262_144, 'deep')).toBe('none');
  });

  it('estimates context from message chars including tool call arguments', async () => {
    const { estimateContextTokens } = await setup();
    /* Divisor is 3.5, measured on a live run (chars/4 undershot by ~13%). */
    expect(estimateContextTokens([{ role: 'user', content: 'abcd' }])).toBe(2);
    expect(estimateContextTokens([
      { role: 'assistant', content: null, tool_calls: [{ function: { name: 'web_search', arguments: '{"queries":["x"]}' } }] },
    ])).toBeGreaterThan(0);
  });

  it('recognises a provider overflow error', async () => {
    const { isContextOverflow } = await setup();
    expect(isContextOverflow(new Error('This model\'s maximum context length is 262144 tokens'))).toBe(true);
    expect(isContextOverflow(new Error('rate limit exceeded'))).toBe(false);
  });
});
