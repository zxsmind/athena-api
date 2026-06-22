/** Lightweight LLM rate-limit signals for deep research cooldown (no smart-routing dependency). */

let recent429Hits = 0;
let pendingRetryAfterMs = 0;

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function parseRetryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

export function recordRateLimitHit(retryAfterMs?: number): void {
  recent429Hits = Math.min(recent429Hits + 1, 20);
  if (retryAfterMs && retryAfterMs > 0) {
    pendingRetryAfterMs = Math.max(pendingRetryAfterMs, retryAfterMs);
  }
}

export function recordRateLimitSuccess(): void {
  recent429Hits = Math.max(0, recent429Hits - 1);
}

export function consumeRateSignalsForCooldown(): { providerPressure: number; retryAfterMs?: number } {
  const providerPressure = clampUnit(recent429Hits / 8);
  const retryAfterMs = pendingRetryAfterMs > 0 ? pendingRetryAfterMs : undefined;
  if (pendingRetryAfterMs > 0) pendingRetryAfterMs = 0;
  return { providerPressure, retryAfterMs };
}

export function resetRateSignalsForTests(): void {
  recent429Hits = 0;
  pendingRetryAfterMs = 0;
}
