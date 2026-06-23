import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESEARCH_DEPTH_PRESETS,
  DEEP_DEPTHS,
  normalizeDeepDepth,
  resolveResearchPreset,
  type ResearchDepthPresetConfig,
} from '../src/engine/depth-presets.js';
import {
  computeCooldownMs,
  createCooldownState,
  recordToolOutcomes,
} from '../src/engine/cooldown.js';
import type { SettingsStore } from '../src/settings-store.js';

function presetConfig(depth: typeof DEEP_DEPTHS[number]): ResearchDepthPresetConfig {
  const { depth: _depthKey, ...config } = DEFAULT_RESEARCH_DEPTH_PRESETS[depth];
  void _depthKey;
  return config;
}

function minimalSettings(): SettingsStore {
  const presets = {} as Record<typeof DEEP_DEPTHS[number], ResearchDepthPresetConfig>;
  for (const depth of DEEP_DEPTHS) presets[depth] = presetConfig(depth);
  return {
    version: 2,
    port: 3001,
    host: '0.0.0.0',
    providers: {},
    providerOrder: [],
    modelRouting: {
      title: { primary: null, fallback: [] },
      reasoning: { primary: null, fallback: [] },
      instant: { primary: null, fallback: [] },
      deep: { primary: null, fallback: [] },
    },
    serper: { keys: [] },
    research: { maxFollowUpQueries: 5 },
    researchDepths: {
      defaultDepth: 'med',
      presets,
    },
    api: {
      defaultMode: 'quick',
      defaultMaxConcurrent: 1,
      maxActiveJobs: 10,
      maxActiveBatches: 5,
      maxEventsPerJob: 500,
      maxEventsPerBatch: 500,
      maxRetentionMinutes: 60,
    },
    general: {
      maxSources: 20,
      deepIterations: 8,
      thinkingStripPatterns: [],
      titleModel: null,
    },
  } as SettingsStore;
}

describe('depth-presets', () => {
  it('normalizes invalid depth to med', () => {
    expect(normalizeDeepDepth('invalid')).toBe('med');
    expect(normalizeDeepDepth('ultra')).toBe('ultra');
  });

  it('resolves quick mode with fixed budget', () => {
    const preset = resolveResearchPreset('quick', undefined, minimalSettings());
    expect(preset.mode).toBe('quick');
    expect(preset.budgetCredits).toBe(6);
    expect(preset.maxRounds).toBe(3);
    expect(preset.maxCooldownMs).toBe(0);
  });

  it('resolves deep depth budgets and rounds', () => {
    const settings = minimalSettings();
    expect(resolveResearchPreset('deep', 'low', settings).budgetCredits).toBe(25);
    expect(resolveResearchPreset('deep', 'med', settings).budgetCredits).toBe(50);
    expect(resolveResearchPreset('deep', 'high', settings).budgetCredits).toBe(80);
    expect(resolveResearchPreset('deep', 'ultra', settings).budgetCredits).toBe(150);
  });

  it('defaults deep without depth to med', () => {
    const preset = resolveResearchPreset('deep', undefined, minimalSettings());
    expect(preset.depth).toBe('med');
    expect(preset.budgetCredits).toBe(50);
  });

  it('applies settings depth preset overrides', () => {
    const settings = minimalSettings();
    settings.researchDepths.presets.low.budgetCredits = 25;
    settings.researchDepths.presets.low.maxRounds = 6;
    const preset = resolveResearchPreset('deep', 'low', settings);
    expect(preset.budgetCredits).toBe(25);
  });
});

describe('cooldown', () => {
  it('returns zero cooldown for quick mode', () => {
    const state = createCooldownState();
    const preset = resolveResearchPreset('quick', undefined, minimalSettings());
    const { ms } = computeCooldownMs({ preset, state, currentRound: 2 });
    expect(ms).toBe(0);
  });

  it('clamps deep-med cooldown within preset bounds', () => {
    const state = createCooldownState();
    const preset = resolveResearchPreset('deep', 'med', minimalSettings());
    const { ms } = computeCooldownMs({ preset, state, currentRound: 5 });
    expect(ms).toBeGreaterThanOrEqual(preset.minCooldownMs);
    expect(ms).toBeLessThanOrEqual(preset.maxCooldownMs * 4);
    expect(ms).toBeGreaterThan(0);
  });

  it('increases cooldown after errors', () => {
    const state = createCooldownState();
    const preset = resolveResearchPreset('deep', 'med', minimalSettings());
    recordToolOutcomes(state, [
      { ok: false, latencyMs: 1000 },
      { ok: false, latencyMs: 1000 },
      { ok: false, latencyMs: 1000 },
    ]);
    const healthy = computeCooldownMs({ preset, state: createCooldownState(), currentRound: 5 });
    const stressed = computeCooldownMs({ preset, state, currentRound: 5 });
    expect(stressed.ms).toBeGreaterThan(healthy.ms);
  });

  it('ultra cooldown never drops below minCooldownMs', () => {
    const state = createCooldownState();
    recordToolOutcomes(state, Array.from({ length: 10 }, () => ({ ok: true, latencyMs: 500 })));
    const preset = resolveResearchPreset('deep', 'ultra', minimalSettings());
    const { ms } = computeCooldownMs({ preset, state, currentRound: 20 });
    expect(ms).toBeGreaterThanOrEqual(DEFAULT_RESEARCH_DEPTH_PRESETS.ultra.minCooldownMs);
  });
});
