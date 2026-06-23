import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const checkpointDir = resolve(__dirname, '..', 'data', 'research-checkpoints');

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
    const preset = {
      depth: 'high' as const,
      mode: 'deep' as const,
      budgetCredits: 50,
      maxRounds: 13,
      minCooldownMs: 20000,
      maxCooldownMs: 40000,
      notebookCadenceRawBlocks: 1,
      minIndependentSourcesForKeyClaims: 3,
      contradictionPass: true,
      primarySourcePreference: true,
      exhaustiveGapReview: false,
      checkpointEveryRounds: 2,
    };

    saveResearchCheckpoint({
      jobId: 'job-old',
      query: 'old query',
      depth: 'high',
      preset,
      notebookId: 'nb-old',
      usedCredits: 10,
      remainingCredits: 40,
      round: 4,
      sourceMap: [],
      lastUpdatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    saveResearchCheckpoint({
      jobId: 'job-new',
      query: 'new query',
      depth: 'ultra',
      preset: { ...preset, depth: 'ultra', budgetCredits: 100, maxRounds: 30 },
      notebookId: 'nb-new',
      usedCredits: 2,
      remainingCredits: 98,
      round: 1,
      sourceMap: [],
      lastUpdatedAt: new Date().toISOString(),
    });

    expect(listResearchCheckpoints()).toHaveLength(2);
    const removed = cleanupStaleCheckpoints(60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(listResearchCheckpoints()).toHaveLength(1);
    expect(listResearchCheckpoints()[0]?.jobId).toBe('job-new');
  });
});
