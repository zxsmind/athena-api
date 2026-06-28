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
    budgetCredits: 25,
    maxRounds: 5,
    minCooldownMs: 5_000,
    maxCooldownMs: 12_000,
    notebookCadenceRawBlocks: 4,
    minIndependentSourcesForKeyClaims: 2,
    contradictionPass: false,
    primarySourcePreference: false,
    exhaustiveGapReview: false,
    checkpointEveryRounds: 0,
  },
  med: {
    depth: 'med',
    budgetCredits: 50,
    maxRounds: 8,
    minCooldownMs: 8_000,
    maxCooldownMs: 25_000,
    notebookCadenceRawBlocks: 2,
    minIndependentSourcesForKeyClaims: 2,
    contradictionPass: true,
    primarySourcePreference: false,
    exhaustiveGapReview: false,
    checkpointEveryRounds: 0,
  },
  high: {
    depth: 'high',
    budgetCredits: 80,
    maxRounds: 13,
    minCooldownMs: 12_000,
    maxCooldownMs: 40_000,
    notebookCadenceRawBlocks: 1,
    minIndependentSourcesForKeyClaims: 3,
    contradictionPass: true,
    primarySourcePreference: true,
    exhaustiveGapReview: false,
    checkpointEveryRounds: 2,
  },
  ultra: {
    depth: 'ultra',
    budgetCredits: 150,
    maxRounds: 30,
    minCooldownMs: 20_000,
    maxCooldownMs: 80_000,
    notebookCadenceRawBlocks: 1,
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
  const finalMaxRounds = Math.max(base.maxRounds, Math.ceil(base.budgetCredits / 2));
  return {
    ...base,
    mode,
    maxRounds: finalMaxRounds,
    budgetCredits: base.budgetCredits,
  };
}

export function depthBehaviorBlock(preset: ResolvedResearchPreset): string {
  if (preset.mode !== 'deep') return '';

  const profiles: Record<DeepDepth, string> = {
    low: `\
**Depth profile: Deep LOW — Quickly Verified**
Your goal is to retrieve accurate, verified information. Speed is a factor, but accuracy is not negotiable.
- Cover the topic from at least two distinct source categories (e.g. official/government site AND independent reporting or community discussion). A single source type is never sufficient.
- Cross-check key claims with at least ${preset.minIndependentSourcesForKeyClaims} independent sources before accepting them.
- **For any official, regulated, or fixed figure** (government fees, legal tariffs, regulated prices, official statistics) — you MUST \`fetch_url\` the primary source page to confirm the exact value. A snippet from a third-party aggregator is not sufficient verification for such figures.
- For figures that genuinely vary by region, institution, or individual (e.g. private service prices) — report the verified range and clearly state why exact values differ. Search for official minimum/base tariffs if they exist.
- A plan item is "resolved" only when its key claims are confirmed by fetched or directly cited primary sources, not merely by search snippets. Stop when all plan items meet this standard and no contradiction remains.`,

    med: `\
**Depth profile: Deep MED — Highly Verified**
Your goal is to produce definitive, high-confidence answers backed by thorough, multi-source evidence.
- Search each evidence need using different query phrasings AND different source categories (official/government, independent news, academic, community forums, expert commentary). Covering only one source category is not acceptable.
- Cross-check key claims with at least ${preset.minIndependentSourcesForKeyClaims} independent sources from different categories.
- **For any official, regulated, or fixed figure** — always \`fetch_url\` the primary source. Snippets from aggregators or secondary sites do not count as verification.
- Actively look for contradictions between sources — if found, investigate the conflict. Do not average conflicting values or ignore the discrepancy.
- Verify that sources are current; if a figure has changed recently, find the most recent authoritative update.
- A plan item is "resolved" only when its claims are multi-source verified including at least one fetched primary source, and no contradiction is open. Do not stop while any plan item is pending or any key claim is contradicted, unverified, or sourced only from snippets.`,

    high: `\
**Depth profile: Deep HIGH — 100% Reliable, No Contradictions**
Your goal is complete certainty: every claim must come from reliable, authoritative sources with zero unresolved contradictions.
- Prioritise primary and authoritative sources (official documentation, institutional publications, direct records, legal texts). When a snippet points to such a source, always \`fetch_url\` it to read the full content — never rely on the snippet alone.
- Cover each evidence need across at least ${preset.minIndependentSourcesForKeyClaims} independent source categories (e.g. official site, independent analysis, expert or academic source).
- **Never accept a figure, fact, or claim that rests only on search snippets.** Every key claim must be traceable to content you have actually fetched and read.
- Resolve every contradiction before finalising. If two authoritative sources disagree, search further to determine which is correct and why.
- Try alternative source categories, languages, or archive versions for any claim you cannot confirm through your first approach.
- Stop only when every plan item is closed, every key claim is verified from fetched sources across multiple categories, and no contradiction or unverified gap remains.`,

    ultra: `\
**Depth profile: Deep ULTRA — Exhaustive, Definitive**
Your goal is to scan the web comprehensively, verify the reliability of each source itself, and reach a level of confidence where you can state conclusions as definitive fact — not "likely" or "estimated".
- Apply everything required for HIGH depth, then go further in every dimension.
- Actively seek out ALL relevant reliable sources on the topic. Do not stop at the first confirming set of results. Search across multiple source categories, languages, time periods, and jurisdictions if relevant.
- Verify sources themselves: check author credibility, publication authority, date of publication, and whether the source has been cited or challenged. Prefer primary over secondary, institutional over individual.
- Every key claim must be confirmed by at least ${preset.minIndependentSourcesForKeyClaims} independent, authoritative, primary sources you have actually \`fetch_url\`'d and read — not merely found in snippets.
- Actively search for contradicting or minority viewpoints and evaluate them. If they are credible, address them in your answer. If not, explain why they are discounted.
- Perform an exhaustive gap review before writing your answer: list every open question, unverified claim, and unresolved contradiction in the notebook and close each one, or state explicitly why it could not be resolved after exhaustive search.
- Stop only when all plan items are closed, every critical claim is confirmed by fetched primary sources, all contradictions are resolved, all gaps are closed or explicitly noted, and you can state your conclusions with full confidence.`,
  };

  return `\n\n${profiles[preset.depth]}\n- Notebook cadence: call \`write_notebook\` after every ${preset.notebookCadenceRawBlocks} uncompacted evidence block(s) to preserve findings before context is compacted.`;
}
