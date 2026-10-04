/**
 * Retry with backoff, for a single search or fetch call.
 *
 * The engine used to wait between every round regardless of outcome, which
 * cost a fixed delay on runs that were already healthy. The wait only ever
 * made sense after a failure, so it lives here: a call that succeeds returns
 * immediately, and only an error buys a delay.
 *
 * After the last delay the error is rethrown. The caller records the real reason
 * rather than swallowing it, so a dead provider is visible instead of turning
 * into a silently short answer.
 */
export interface RetryOutcome<T> {
  ok: boolean;
  value?: T;
  error?: string;
  attempts: number;
  /** Total milliseconds spent waiting, for the trace and the step log. */
  waitedMs: number;
}

export async function withRetry<T>(
  label: string,
  delaysMs: number[],
  attempt: () => Promise<T>,
  hooks: {
    onRetry?: (info: { attempt: number; delayMs: number; error: string }) => void;
    signal?: AbortSignal;
    /**
     * A provider-reported wait, such as a `Retry-After` header. It wins over the
     * configured backoff, because the upstream knows how long it needs and a
     * shorter guess just produces another 429.
     */
    retryAfterMs?: () => number | undefined;
  } = {},
): Promise<RetryOutcome<T>> {
  let waitedMs = 0;
  for (let index = 0; index <= delaysMs.length; index += 1) {
    if (hooks.signal?.aborted) {
      return { ok: false, error: 'cancelled', attempts: index, waitedMs };
    }
    try {
      const value = await attempt();
      return { ok: true, value, attempts: index + 1, waitedMs };
    } catch (err: unknown) {
      const message = (err as Error).message || String(err);
      /* A caller abort is not a provider failure; stop immediately. */
      if (hooks.signal?.aborted) {
        return { ok: false, error: 'cancelled', attempts: index + 1, waitedMs };
      }
      if (index === delaysMs.length) {
        return { ok: false, error: message, attempts: index + 1, waitedMs };
      }
      const upstream = hooks.retryAfterMs?.();
      const delayMs = upstream !== undefined && upstream > 0 ? upstream : delaysMs[index];
      hooks.onRetry?.({ attempt: index + 1, delayMs, error: message });
      await sleep(delayMs, hooks.signal);
      waitedMs += delayMs;
    }
  }
  /* Unreachable: the loop returns on the final iteration. */
  return { ok: false, error: `${label} failed`, attempts: delaysMs.length + 1, waitedMs };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', finish);
      resolve();
    }
    if (signal) {
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
    }
  });
}
