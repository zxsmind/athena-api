import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveResearchPreset } from '../src/engine/modes.js';

const checkpointDir = resolve(process.env.ATHENA_DATA_DIR ?? resolve(import.meta.dirname, '..', 'data'), 'research-checkpoints');

describe('checkpoint', () => {
  beforeEach(() => {
    if (existsSync(checkpointDir)) {
      rmSync(checkpointDir, { recursive: true, force: true });
    }
    mkdirSync(checkpointDir, { recursive: true });
    vi.resetModules();
  });

  it('lists and cleans stale checkpoints', async () => {
    const { saveResearchCheckpoint, listResearchCheckpoints, cleanupStaleCheckpoints } = await import('../src/engine/checkpoint.js');
    const preset = resolveResearchPreset('deep');
    const maxPreset = resolveResearchPreset('max');
    const budget = { usedSearchCalls: 0, usedFetchCalls: 0, usedTokens: 0, startedAt: Date.now(), usedSteps: 0, usedTurns: 0, exhaustedBy: null };

    saveResearchCheckpoint({
      jobId: 'job-old',
      query: 'old query',
      preset,
      budget,
      round: 4,
      sourceMap: [],
      lastUpdatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    saveResearchCheckpoint({
      jobId: 'job-new',
      query: 'new query',
      preset: maxPreset,
      budget,
      round: 1,
      sourceMap: [],
      lastUpdatedAt: new Date().toISOString(),
    });

    expect(listResearchCheckpoints()).toHaveLength(2);
    expect(cleanupStaleCheckpoints(60 * 60 * 1000)).toBe(1);
    expect(listResearchCheckpoints()).toHaveLength(1);
    expect(listResearchCheckpoints()[0]?.jobId).toBe('job-new');
  });

  it('restores the exact budget counters that were saved', async () => {
    const { saveResearchCheckpoint, loadResearchCheckpoint } = await import('../src/engine/checkpoint.js');
    const preset = resolveResearchPreset('deep');
    const budget = {
      usedSearchCalls: 7,
      usedFetchCalls: 3,
      usedTokens: 1234,
      startedAt: 1_700_000_000_000,
      usedSteps: 5,
      usedTurns: 5,
      exhaustedBy: null as null,
      tokenLedger: {
        'acme/sonnet': {
          providerId: 'acme', modelId: 'sonnet',
          inputTokens: 800, outputTokens: 300,
          cacheReadTokens: 134, cacheWriteTokens: 0,
          requests: 2,
        },
      },
    };

    saveResearchCheckpoint({
      jobId: 'job-restore',
      query: 'q',
      preset,
      budget,
      round: 5,
      sourceMap: [],
      lastUpdatedAt: new Date().toISOString(),
    });

    const restored = loadResearchCheckpoint('job-restore');
    expect(restored?.budget).toEqual(budget);
    expect(restored?.preset.mode).toBe('deep');
  });
});
