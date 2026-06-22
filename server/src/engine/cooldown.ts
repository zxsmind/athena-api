import type { ResolvedResearchPreset } from './depth-presets.js';

export interface ResearchCooldownState {
  recentToolOutcomes: ToolOutcome[];
  recent429Count: number;
  successStreak: number;
  lastCooldownMs: number;
}

export interface ToolOutcome {
  ok: boolean;
  latencyMs: number;
  is429?: boolean;
}

export interface CooldownInput {
  preset: ResolvedResearchPreset;
  state: ResearchCooldownState;
  remainingRounds: number;
  providerPressure?: number;
  retryAfterMs?: number;
}

export function createCooldownState(): ResearchCooldownState {
  return {
    recentToolOutcomes: [],
    recent429Count: 0,
    successStreak: 0,
    lastCooldownMs: 0,
  };
}

function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function recentErrorRate(state: ResearchCooldownState, window = 10): number {
  const slice = state.recentToolOutcomes.slice(-window);
  if (slice.length === 0) return 0;
  const failures = slice.filter(o => !o.ok).length;
  return failures / slice.length;
}

function avgLatencyMs(state: ResearchCooldownState, window = 10): number {
  const slice = state.recentToolOutcomes.slice(-window);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, o) => sum + o.latencyMs, 0) / slice.length;
}

export function recordToolOutcomes(state: ResearchCooldownState, outcomes: ToolOutcome[]): void {
  for (const outcome of outcomes) {
    state.recentToolOutcomes.push(outcome);
    if (outcome.is429) state.recent429Count += 1;
    if (outcome.ok) {
      state.successStreak += 1;
    } else {
      state.successStreak = 0;
    }
  }
  if (state.recentToolOutcomes.length > 50) {
    state.recentToolOutcomes = state.recentToolOutcomes.slice(-50);
  }
}

export function computeCooldownMs(input: CooldownInput): { ms: number; reason: string } {
  const { preset, state, remainingRounds, providerPressure = 0, retryAfterMs } = input;

  if (preset.mode === 'quick' || preset.maxCooldownMs <= 0) {
    return { ms: 0, reason: 'no cooldown for instant mode' };
  }

  if (retryAfterMs && retryAfterMs > 0) {
    const ms = preset.depth === 'ultra'
      ? Math.max(retryAfterMs, preset.minCooldownMs)
      : retryAfterMs;
    return { ms, reason: `provider retry-after ${Math.round(ms / 1000)}s` };
  }

  const base = randomBetween(preset.minCooldownMs, preset.maxCooldownMs);
  const errorPenalty = recentErrorRate(state) * 2.0;
  const rateLimitPenalty = state.recent429Count > 0 ? 1.5 : 0;
  const latencyPenalty = avgLatencyMs(state) > 20_000 ? 0.5 : 0;
  const pressurePenalty = providerPressure;
  const healthyBonus = state.successStreak >= 5 ? -0.25 : 0;
  const urgentBonus = remainingRounds <= 2 && preset.depth !== 'ultra' ? -0.15 : 0;

  const multiplier = 1 + errorPenalty + rateLimitPenalty + latencyPenalty + pressurePenalty + healthyBonus + urgentBonus;
  const maxCap = preset.depth === 'ultra' ? Math.max(preset.maxCooldownMs * 5, 300_000) : preset.maxCooldownMs * 4;
  let ms = clamp(base * multiplier, preset.minCooldownMs, maxCap);

  if (preset.depth === 'ultra') {
    ms = Math.max(ms, preset.minCooldownMs);
  }

  const parts: string[] = [`deep-${preset.depth} pacing ${Math.round(ms / 1000)}s`];
  if (errorPenalty > 0) parts.push('recent errors');
  if (rateLimitPenalty > 0) parts.push('rate limits');
  if (latencyPenalty > 0) parts.push('high latency');
  if (healthyBonus < 0) parts.push('healthy streak');

  return { ms: Math.round(ms), reason: parts.join(', ') };
}

export async function waitCooldown(
  ms: number,
  reason: string,
  signal?: AbortSignal,
  onWait?: (note: string) => void,
): Promise<boolean> {
  if (ms <= 0 || signal?.aborted) return !signal?.aborted;

  const note = `Waiting ${Math.round(ms / 1000)}s — ${reason}`;
  onWait?.(note);

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      if (signal.aborted) {
        clearTimeout(timer);
        resolve(false);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
