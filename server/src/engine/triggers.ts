import { getCachedModelsDevModel, findModelWindowAcrossProviders } from '../models-dev.js';
import { loadSettings } from '../settings-store.js';
import type { ResearchMode } from './modes.js';

/**
 * Window-aware triggers.
 *
 * Two different natures, computed differently:
 *
 * - the proactive trigger is absolute (a token count): cost and latency do not
 *   care how big the window is;
 * - hard prevents overflow, which is relative to the window by definition:
 *   hardAt = window − margin. The margin (10% by default) covers estimator
 *   error — chars/4 overestimates Latin-heavy content (safe direction) but can
 *   underestimate dense non-Latin text by more. The emergency overflow retry is
 *   the backstop for that tail.
 */

export interface WindowCandidate {
  providerId: string;
  model: string;
}

/**
 * Resolves the window a job must fit in.
 *
 * The next call may be served by the route primary or by whichever model
 * served last (routing can fall back mid-job), so the window is the smallest
 * resolved window among the models that might serve it. Unknown when nothing
 * resolves — then there are no ratio triggers, only the emergency retry, and
 * the trace says so.
 *
 * Each candidate is looked up by provider first, then by model id across the
 * whole catalog: a custom endpoint name never matches a catalog provider, but
 * the model id is stable wherever the model is served.
 */
export function resolveContextWindow(
  primary: WindowCandidate | null,
  lastUsed: WindowCandidate | null,
): number | null {
  const windows: number[] = [];
  for (const candidate of [primary, lastUsed]) {
    if (!candidate?.model) continue;
    let limit: number | undefined;
    if (candidate.providerId) {
      const scoped = getCachedModelsDevModel(candidate.providerId, candidate.model)?.limit?.context;
      if (typeof scoped === 'number' && Number.isFinite(scoped) && scoped > 0) limit = scoped;
    }
    if (limit === undefined) {
      const global = findModelWindowAcrossProviders(candidate.model);
      if (global !== null) limit = global;
    }
    if (limit !== undefined) windows.push(limit);
  }
  return windows.length > 0 ? Math.min(...windows) : null;
}

/**
 * The route primary for research work, if one is configured for the mode.
 * Takes the mode, because the routes are per mode.
 */
export function researchRoutePrimary(mode?: ResearchMode): WindowCandidate | null {
  try {
    const routing = loadSettings().modelRouting;
    /* With no mode given the widest route is the safe answer: it is the ceiling
       a run has to fit under whichever model serves it. */
    const primary = mode ? routing?.[mode]?.primary : routing?.max?.primary;
    if (primary?.providerId && primary?.model) {
      return { providerId: primary.providerId, model: primary.model };
    }
  } catch {
    return null;
  }
  return configuredProviderModel();
}

/**
 * The model a settings file points at when no route does.
 *
 * A single enabled provider with exactly one model names the window
 * unambiguously, so that is what this resolves. It returns null when several
 * providers or models are configured, because then the choice belongs to the
 * route and guessing one would size the window against a model that may not
 * serve the job.
 */
function configuredProviderModel(): WindowCandidate | null {
  try {
    const providers = loadSettings().providers ?? {};
    const enabled = Object.entries(providers).filter(([, provider]) => provider.enabled && provider.models.length === 1);
    if (enabled.length !== 1) return null;
    const [providerId, provider] = enabled[0];
    return { providerId, model: provider.models[0] };
  } catch {
    return null;
  }
}

export type CompactionTier = 'none' | 'soft' | 'hard';

/**
 * Which tier applies, if any. `instant` never compacts: its budget is small
 * enough that the window is not the constraint.
 */
export function compactionTier(
  usageTokens: number,
  triggerTokens: number,
  windowTokens: number | null,
  mode: string,
): CompactionTier {
  if (mode === 'instant' || triggerTokens <= 0) return 'none';
  if (usageTokens >= triggerTokens) return 'soft';
  if (windowTokens !== null && windowTokens > 0 && usageTokens >= Math.floor(0.9 * windowTokens)) return 'hard';
  return 'none';
}

/**
 * Current context size in tokens, estimated. Character counting divided by 3.5
 * is rough but immediate; the provider-measured input count lags by a round
 * because messages grow after every call.
 *
 * The divisor is measured, not picked. Across twelve rounds of a live run the
 * chars/4 estimate came in at 0.61-0.94 of the provider-reported total (mean
 * 0.87), so 4 systematically undershoots and compaction triggers late, which
 * is the unsafe direction. 3.5 centers the same run at 1.00. Re-measure on a
 * new provider or a different content mix before trusting it elsewhere:
 * Turkish prose and JSON tool schemas tokenize denser than English prose.
 *
 * Emergency retry covers a remaining underestimate, and overestimation only
 * compacts early, which is safe.
 */
export function estimateContextTokens(messages: { role: string; content?: string | null; tool_calls?: { function: { name: string; arguments: string } }[] }[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        chars += (tc.function?.name ?? '').length + (tc.function?.arguments ?? '').length;
      }
    }
  }
  return Math.ceil(chars / 3.5);
}

/** True when a provider error means the prompt no longer fits its window. */
export function isContextOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /context[_ ]length|maximum context|context window|too many tokens|input.*too (long|large)|prompt.*too (long|large)/i.test(message);
}
