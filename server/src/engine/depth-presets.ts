import type { SettingsStore } from '../settings-store.js';

export const DEEP_DEPTHS = ['low', 'med', 'high', 'ultra'] as const;
export type DeepDepth = typeof DEEP_DEPTHS[number];

export interface ResearchDepthPreset {
  depth: DeepDepth;
  budgetCredits: number;
  maxRounds: number;
  minCooldownMs: number;
  maxCooldownMs: number;
  notebookCadenceRawBlocks: number;
  maxSearchesPerRound: number;
  maxFetchesPerRound: number;
  minIndependentSourcesForKeyClaims: number;
  contradictionPass: boolean;
  primarySourcePreference: boolean;
  exhaustiveGapReview: boolean;
  checkpointEveryRounds: number;
}

/** Stored per-depth in settings (depth is the map key). */
export type ResearchDepthPresetConfig = Omit<ResearchDepthPreset, 'depth'>;

export const DEFAULT_DEEP_DEPTH: DeepDepth = 'med';

export const DEFAULT_RESEARCH_DEPTH_PRESETS: Record<DeepDepth, ResearchDepthPreset> = {
  low: {
    depth: 'low',
    budgetCredits: 20,
    maxRounds: 5,
    minCooldownMs: 5_000,
    maxCooldownMs: 10_000,
    notebookCadenceRawBlocks: 2,
    maxSearchesPerRound: 4,
    maxFetchesPerRound: 2,
    minIndependentSourcesForKeyClaims: 2,
    contradictionPass: false,
    primarySourcePreference: false,
    exhaustiveGapReview: false,
    checkpointEveryRounds: 0,
  },
  med: {
    depth: 'med',
    budgetCredits: 35,
    maxRounds: 8,
    minCooldownMs: 10_000,
    maxCooldownMs: 15_000,
    notebookCadenceRawBlocks: 2,
    maxSearchesPerRound: 5,
    maxFetchesPerRound: 3,
    minIndependentSourcesForKeyClaims: 2,
    contradictionPass: true,
    primarySourcePreference: false,
    exhaustiveGapReview: false,
    checkpointEveryRounds: 0,
  },
  high: {
    depth: 'high',
    budgetCredits: 50,
    maxRounds: 13,
    minCooldownMs: 20_000,
    maxCooldownMs: 40_000,
    notebookCadenceRawBlocks: 1,
    maxSearchesPerRound: 6,
    maxFetchesPerRound: 4,
    minIndependentSourcesForKeyClaims: 3,
    contradictionPass: true,
    primarySourcePreference: true,
    exhaustiveGapReview: false,
    checkpointEveryRounds: 2,
  },
  ultra: {
    depth: 'ultra',
    budgetCredits: 100,
    maxRounds: 30,
    minCooldownMs: 60_000,
    maxCooldownMs: 60_000,
    notebookCadenceRawBlocks: 1,
    maxSearchesPerRound: 8,
    maxFetchesPerRound: 6,
    minIndependentSourcesForKeyClaims: 3,
    contradictionPass: true,
    primarySourcePreference: true,
    exhaustiveGapReview: true,
    checkpointEveryRounds: 2,
  },
};

export interface ResolvedResearchPreset extends ResearchDepthPreset {
  mode: 'quick' | 'deep';
}

export function normalizeDeepDepth(value: unknown): DeepDepth {
  return DEEP_DEPTHS.includes(value as DeepDepth) ? value as DeepDepth : DEFAULT_DEEP_DEPTH;
}

export function resolveResearchPreset(
  mode: 'quick' | 'deep',
  depth: unknown,
  settings: SettingsStore,
): ResolvedResearchPreset {
  if (mode === 'quick') {
    return {
      ...DEFAULT_RESEARCH_DEPTH_PRESETS.low,
      mode,
      depth: 'low',
      budgetCredits: 6,
      maxRounds: 3,
      minCooldownMs: 0,
      maxCooldownMs: 0,
      notebookCadenceRawBlocks: 0,
    };
  }

  const normalizedDepth = normalizeDeepDepth(depth ?? settings.researchDepths?.defaultDepth);
  const settingsOverride = settings.researchDepths?.presets?.[normalizedDepth];
  const baseDefaults = DEFAULT_RESEARCH_DEPTH_PRESETS[normalizedDepth];
  const base: ResearchDepthPreset = settingsOverride
    ? { ...baseDefaults, depth: normalizedDepth, ...settingsOverride }
    : baseDefaults;
  const legacyLimit = Math.max(1, settings.research.maxCreditsPerQuery || base.budgetCredits);
  return {
    ...base,
    mode,
    budgetCredits: Math.max(base.budgetCredits, legacyLimit),
  };
}

export function depthBehaviorBlock(preset: ResolvedResearchPreset): string {
  if (preset.mode !== 'deep') return '';

  const lines = [
    `**Depth profile:** Deep ${preset.depth.toUpperCase()}.`,
    `- Research budget: ${preset.budgetCredits} search/fetch credits across up to ${preset.maxRounds} rounds.`,
    `- Notebook cadence: write the notebook when ${preset.notebookCadenceRawBlocks} raw evidence block(s) are still uncompacted.`,
    `- Per round target: no more than ${preset.maxSearchesPerRound} searches and ${preset.maxFetchesPerRound} fetches unless a critical gap requires it.`,
    `- Key claims should have at least ${preset.minIndependentSourcesForKeyClaims} independent supporting source(s) when available.`,
  ];

  if (preset.primarySourcePreference) {
    lines.push('- Prefer primary or authoritative sources; fetch them when snippets are insufficient.');
  }
  if (preset.contradictionPass) {
    lines.push('- Actively look for contradictions and resolve them before finalizing.');
  }
  if (preset.exhaustiveGapReview) {
    lines.push('- Run exhaustive gap review: preserve every unresolved material issue in the notebook until closed or explicitly unverified.');
  }

  return `\n\n${lines.join('\n')}`;
}
