/**
 * Per-job sandbox sessions plus the concurrency cap from `sandbox.maxConcurrent`
 * (D5). Sessions are created lazily, so a job that never calls `run_code` never
 * pays for one. The cap bounds simultaneous executions; a run that cannot get a
 * slot waits, and an aborted signal drops it from the queue.
 */
import { getConfig } from '../config/load.js';
import { PyodideSession } from './pyodide-session.js';
import type { SandboxHandlers, SandboxRunResult, SandboxSession } from './types.js';

export type SandboxSessionFactory = (handlers: SandboxHandlers, options: { timeoutMs: number }) => SandboxSession;

const defaultFactory: SandboxSessionFactory = (handlers, options) => new PyodideSession(handlers, options);

const sessions = new Map<string, SandboxSession>();
let factory: SandboxSessionFactory = defaultFactory;
let running = 0;
const waiters: Array<() => void> = [];

function acquire(signal?: AbortSignal): Promise<() => void> {
  const limit = getConfig().sandbox.maxConcurrent;
  const release = (): void => {
    running--;
    const next = waiters.shift();
    if (next) next();
  };
  if (running < limit) {
    running++;
    return Promise.resolve(release);
  }
  return new Promise((resolveAcquire, rejectAcquire) => {
    const waiter = (): void => {
      running++;
      resolveAcquire(release);
    };
    waiters.push(waiter);
    if (signal) {
      signal.addEventListener('abort', () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) {
          waiters.splice(index, 1);
          rejectAcquire(new Error('Sandbox queue aborted.'));
        }
      }, { once: true });
    }
  });
}

function sessionFor(jobId: string, handlers: SandboxHandlers): SandboxSession {
  let session = sessions.get(jobId);
  if (!session) {
    session = factory(handlers, { timeoutMs: getConfig().sandbox.timeoutMs });
    sessions.set(jobId, session);
  }
  session.setHandlers(handlers);
  return session;
}

/** Runs one program under the concurrency cap. Never throws for program errors. */
export async function runInSandbox(
  jobId: string,
  handlers: SandboxHandlers,
  code: string,
  signal?: AbortSignal,
): Promise<SandboxRunResult> {
  if (!getConfig().sandbox.enabled) {
    return { ok: false, value: '', stdout: '', error: 'Code execution is disabled.' };
  }
  let release: () => void;
  try {
    release = await acquire(signal);
  } catch (error) {
    return { ok: false, value: '', stdout: '', error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return await sessionFor(jobId, handlers).run(code, signal);
  } finally {
    release();
  }
}

/** The model's explicit `state`, or null when this job never ran code. */
export async function exportSandboxState(jobId: string): Promise<string | null> {
  const session = sessions.get(jobId);
  if (!session) return null;
  try {
    return await session.exportState();
  } catch {
    return null;
  }
}

/** Restores a checkpointed `state` into the job's session. */
export function hydrateSandbox(jobId: string, handlers: SandboxHandlers, state: string): void {
  sessionFor(jobId, handlers).hydrate(state);
}

export function closeSandbox(jobId: string): void {
  const session = sessions.get(jobId);
  if (!session) return;
  sessions.delete(jobId);
  session.close();
}

export function closeAllSandboxes(): void {
  for (const jobId of Array.from(sessions.keys())) closeSandbox(jobId);
}

/** Test seam: the default factory spawns a real Pyodide process. */
export function setSandboxFactoryForTests(next: SandboxSessionFactory | null): void {
  factory = next ?? defaultFactory;
}
