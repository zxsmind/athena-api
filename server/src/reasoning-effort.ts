/**
 * Reasoning effort: what the value means and how a mode's request lands on a
 * model that names its own values.
 *
 * This module is pure on purpose. It is imported by the LLM transport, which has
 * a large module-level graph, and by the setup wizard, which has none — so the
 * rules live where both can read them without dragging side effects along.
 */

/** Every effort value this code can name, ordered by how hard it thinks.
 *
 *  `max` exists in the models.dev catalog (`{low, medium, high, xhigh, max}` for
 *  1782 models) and `default` in one listing; both are candidates the catalog
 *  can hand back, never values a mode asks for. `minimal` and `high` carry
 *  settings values: `minimal` for 627 and `high` for 3805 models. */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_RANK: Record<ReasoningEffort, number> = {
  none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6,
};

/** What a mode asks for, before the model has a say in it. Ordered so the
 *  position can be read as a rung rather than as a label. */
export const MODE_EFFORT_RUNGS = [
  { mode: 'instant', effort: 'none' },
  { mode: 'default', effort: 'low' },
  { mode: 'deep', effort: 'medium' },
  { mode: 'max', effort: 'xhigh' },
] as const satisfies ReadonlyArray<{ mode: string; effort: ReasoningEffort }>;

/**
 * What a model's vocabulary says about a requested effort.
 *
 * `unknown` and `omit` are deliberately different answers, because the caller
 * must do opposite things with them: nothing is known, so keep the previous
 * behaviour, or the question is settled and the field is left off the request.
 */
export type EffortResolution =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'send'; readonly effort: ReasoningEffort }
  | { readonly kind: 'omit' };

/**
 * The effort a model should be sent for a round.
 *
 * The mode names a rung; the model's own vocabulary from the catalog decides
 * which value fills it. A mode asking for a value the model supports sends
 * exactly that, so nothing changes for the majority of models. Where the model
 * lacks granularity the rung is mapped onto the values it does accept:
 *
 * - `low` (the cheap rung) clamps DOWN to the highest supported value at or
 *   below low, because the cheap mode must stay cheap. A model whose floor is
 *   `high` therefore omits the field for a low round.
 * - `medium` takes the middle of what is supported, so a gappy ladder still
 *   reads as "harder than the cheap mode".
 * - `xhigh` takes the highest supported value, so a model without xhigh spends
 *   its own ceiling while a model that has it is sent exactly what the mode
 *   asked for. `max` is reachable this way for the 1782 models that list it,
 *   which the transport's own vocabulary could not express at all before.
 * - `none` sends nothing when the model supports none, and the lowest supported
 *   value when it does not: 2425 reasoning models in the catalog accept no
 *   `none`, and dropping the field there leaves the provider to decide, which is
 *   the silence this whole path exists to avoid.
 */
export function resolveModelEffort(
  requested: ReasoningEffort | undefined,
  supported: readonly string[] | null,
): EffortResolution {
  if (!supported) return { kind: 'unknown' };
  const values = supported.filter((value) => value !== 'none');
  if (requested === 'none') {
    if (supported.includes('none')) return { kind: 'send', effort: 'none' };
    /* The model's floor is the closest thing to "not thinking" it can express.
       A model whose only value is `high` has nothing cheaper, so that is sent. */
    if (values.length === 0) return { kind: 'unknown' };
    return { kind: 'send', effort: lowest(values) };
  }
  if (!requested) return { kind: 'unknown' };
  const rung = MODE_EFFORT_RUNGS.findIndex((entry) => entry.effort === requested);
  if (rung === -1) return { kind: 'unknown' };
  if (supported.includes(requested)) return { kind: 'send', effort: requested };
  if (values.length === 0) return { kind: 'unknown' };
  if (rung === 1) {
    const below = highestAtOrBelow(values, requested);
    return below === null ? { kind: 'omit' } : { kind: 'send', effort: below };
  }
  if (rung === 2) return { kind: 'send', effort: middle(values) };
  /* The top rung spends whatever the model offers, including `max`, which sits
     above xhigh in the catalog: a mode that asked for the hardest thinking gets
     the hardest this model can do. A model that supports xhigh still gets xhigh
     exactly, because the exact match above already answered. */
  return { kind: 'send', effort: highest(values) };
}

/**
 * The provider's `reasoningEffort` is a floor, not a fallback: the round's
 * effort can only go up from here. Without a floor the round passes through
 * untouched, so providers that never set one behave exactly as before.
 *
 * No value is rounded on its way through. `minimal` and `high` are wire values
 * for 627 and 3805 catalog models, so lifting `high` to `xhigh` would send more
 * thinking than the operator named to models that reject it.
 */
export function applyReasoningFloor(
  round: ReasoningEffort | undefined,
  floor: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (!floor) return round;
  if (!round) return floor;
  return EFFORT_RANK[round] >= EFFORT_RANK[floor] ? round : floor;
}

function lowest(values: string[]): ReasoningEffort {
  let best = values[0] as ReasoningEffort;
  for (const value of values) {
    if (rank(value) < rank(best)) best = value as ReasoningEffort;
  }
  return best;
}

function highest(values: string[]): ReasoningEffort {
  let best = values[0] as ReasoningEffort;
  for (const value of values) {
    if (rank(value) > rank(best)) best = value as ReasoningEffort;
  }
  return best;
}

/** The highest value that does not think harder than the ceiling, or null when
 *  every supported value exceeds it. */
function highestAtOrBelow(values: string[], ceiling: ReasoningEffort): ReasoningEffort | null {
  let best: ReasoningEffort | null = null;
  for (const value of values) {
    if (rank(value) > rank(ceiling)) continue;
    if (best === null || rank(value) > rank(best)) best = value as ReasoningEffort;
  }
  return best;
}

/** The middle of the supported values: the middle index, and the higher of the
 *  two when the count is even, so a gappy ladder still leans up. */
function middle(values: string[]): ReasoningEffort {
  const sorted = [...values].sort((a, b) => rank(a) - rank(b));
  return sorted[Math.floor(sorted.length / 2)] as ReasoningEffort;
}

function rank(value: string): number {
  return EFFORT_RANK[value as ReasoningEffort] ?? 0;
}
