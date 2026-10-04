/**
 * Runs `signal` through a timeout. Shared by search and page extraction so a
 * single hanging upstream request cannot block a whole research round.
 */
export function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clean: () => void } {
  if (signal?.aborted) return { signal, clean: () => {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const clean = () => { clearTimeout(timer); };
  if (!signal) return { signal: ctrl.signal, clean };
  const onAbort = () => { clearTimeout(timer); ctrl.abort(); };
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    clean: () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); },
  };
}
