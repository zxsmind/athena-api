/**
 * Retry-After parsing for a rate-limited provider.
 *
 * The engine used to keep a rolling 429 counter here and feed it into a
 * per-round cooldown. With the cooldown gone this module is only the parser:
 * when a provider says how long to wait, the retry loop honours that number
 * instead of its own backoff step, because the upstream knows better than we do.
 */
export function parseRetryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}
