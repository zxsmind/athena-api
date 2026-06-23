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
  currentRound: number;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
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
  const { preset, state, currentRound, providerPressure = 0, retryAfterMs } = input;

  if (preset.mode === 'quick' || preset.maxCooldownMs <= 0) {
    return { ms: 0, reason: 'no cooldown for instant mode' };
  }

  /* Retry-After from upstream provider takes priority */
  if (retryAfterMs && retryAfterMs > 0) {
    const ms = preset.depth === 'ultra'
      ? Math.max(retryAfterMs, preset.minCooldownMs)
      : retryAfterMs;
    return { ms, reason: `provider retry-after ${Math.round(ms / 1000)}s` };
  }

  /* Progressive base: short early, longer as research deepens */
  const progress = preset.maxRounds > 0
    ? clamp(currentRound / preset.maxRounds, 0, 1)
    : 1;
  const baseMs = lerp(preset.minCooldownMs, preset.maxCooldownMs, progress);

  /* Dynamic adjustments */
  const errorRate = recentErrorRate(state);
  const errorMultiplier = 1 + errorRate * 3;

  const streakDiscount = state.successStreak >= 3
    ? Math.max(0.5, 1 - (state.successStreak - 2) * 0.05)
    : 1;

  const rateLimitPenalty = state.recent429Count > 0 ? 1.3 : 1;
  const latencyPenalty = avgLatencyMs(state) > 30_000 ? 1.25 : 1;
  const pressurePenalty = 1 + providerPressure;

  let ms = baseMs * errorMultiplier * streakDiscount * rateLimitPenalty * latencyPenalty * pressurePenalty;

  /* Cap: never below start, never above 5x end */
  const hardMin = preset.minCooldownMs;
  const hardMax = Math.max(preset.maxCooldownMs * 5, 300_000);
  ms = clamp(ms, hardMin, hardMax);

  const parts: string[] = [`deep-${preset.depth} round ${currentRound + 1} pacing ${Math.round(ms / 1000)}s`];
  if (errorRate > 0) parts.push(`errors ${Math.round(errorRate * 100)}%`);
  if (state.recent429Count > 0) parts.push('rate limited');
  if (latencyPenalty > 1) parts.push('high latency');
  if (streakDiscount < 1) parts.push('good streak');

  return { ms: Math.round(ms), reason: parts.join(', ') };
}

export async function waitCooldown(
  ms: number,
  reason: string,
  signal?: AbortSignal,
  onWait?: (note: string) => void,
  onHeartbeat?: (note: string) => void,
): Promise<boolean> {
  if (ms <= 0 || signal?.aborted) return !signal?.aborted;

  const note = `Waiting ${Math.round(ms / 1000)}s — ${reason}`;
  onWait?.(note);

  const heartbeatIntervalMs = 8_000;
  const startedAt = Date.now();
  return new Promise<boolean>((resolve) => {
    const mainTimer = setTimeout(() => {
      clearInterval(heartbeatTimer);
      resolve(true);
    }, ms);
    const heartbeatTimer = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(heartbeatTimer);
        clearTimeout(mainTimer);
        resolve(false);
        return;
      }
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, ms - elapsedMs);
      const remainingSec = Math.round(remainingMs / 1000);
      onHeartbeat?.(`Still waiting ${remainingSec}s — ${reason}`);
    }, heartbeatIntervalMs);
    if (signal) {
      const onAbort = () => {
        clearInterval(heartbeatTimer);
        clearTimeout(mainTimer);
        resolve(false);
      };
      if (signal.aborted) {
        clearInterval(heartbeatTimer);
        clearTimeout(mainTimer);
        resolve(false);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
