/**
 * Pyodide session: one child process running `pyodide-host.ts` with a
 * newline-delimited JSON protocol. The session owns process lifetime, run
 * timeouts, abort handling, and state export/restore; the engine owns what the
 * injected functions mean.
 *
 * A timed-out run kills the process. The next run starts a fresh one and
 * replays the last exported `state`, so a runaway program cannot poison the
 * job's interpreter.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SandboxHandlers, SandboxRunResult, SandboxSession } from './types.js';

const HOST_ENTRY = fileURLToPath(new URL('./pyodide-host.js', import.meta.url));
const HOST_SOURCE = fileURLToPath(new URL('./pyodide-host.ts', import.meta.url));
const HOST_CLIP_ERRORS = 3;

interface HostMessage {
  type: 'ready' | 'rpc' | 'result';
  id?: string;
  fn?: string;
  args?: Record<string, unknown>;
  value?: unknown;
  stdout?: string;
  error?: string;
  ok?: boolean;
}

/** Only non-secret variables reach the sandbox host. `js.process.env` is
 *  reachable from Python, so the child is given nothing worth reading. */
function childEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'LANG']) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface PyodideSessionOptions {
  timeoutMs: number;
}

export class PyodideSession implements SandboxSession {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private handlers: SandboxHandlers;
  private buffer = '';
  private stderrLines: string[] = [];
  private pending = new Map<string, (message: { ok: boolean; value?: string; stdout?: string; error?: string }) => void>();
  private lastState: string | null = null;
  private hydratePending: string | null = null;
  private closed = false;

  constructor(handlers: SandboxHandlers, private readonly options: PyodideSessionOptions) {
    this.handlers = handlers;
  }

  setHandlers(handlers: SandboxHandlers): void {
    this.handlers = handlers;
  }

  private spawnHost(): void {
    const args = existsSync(HOST_ENTRY) ? [HOST_ENTRY] : ['--import', 'tsx', HOST_SOURCE];
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr!.on('data', (chunk: string) => {
      this.stderrLines.push(chunk.trim());
      if (this.stderrLines.length > HOST_CLIP_ERRORS) this.stderrLines.shift();
    });
    child.on('exit', (code) => this.onExit(child, code));
    this.child = child;
    this.buffer = '';
    this.ready = new Promise((resolveReady) => (this.readyResolve = resolveReady));
  }

  private get stderrTail(): string {
    return this.stderrLines.filter(Boolean).join(' | ').slice(0, 400);
  }

  private onExit(child: ChildProcess, code: number | null): void {
    /* `kill()` is asynchronous: the old process can exit after a replacement
       has already been spawned. A stale exit must not clear the new child. */
    if (this.child !== null && this.child !== child) return;
    this.readyResolve?.();
    this.readyResolve = null;
    this.ready = null;
    this.child = null;
    const detail = this.stderrTail;
    for (const settle of this.pending.values()) {
      settle({ ok: false, error: `Sandbox host exited (code ${code ?? 'null'})${detail ? `: ${detail}` : ''}` });
    }
    this.pending.clear();
    if (!this.closed) {
      /* Exit after ready is either a timeout kill or a crash; both are reported
         through the pending run. Nothing to do here but stay quiet. */
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: HostMessage;
      try {
        message = JSON.parse(line) as HostMessage;
      } catch {
        continue;
      }
      if (message.type === 'ready') {
        this.readyResolve?.();
        this.readyResolve = null;
      } else if (message.type === 'rpc') {
        void this.onRpc(message);
      } else if (message.type === 'result' && message.id) {
        const settle = this.pending.get(message.id);
        if (settle) {
          this.pending.delete(message.id);
          settle({ ok: Boolean(message.ok), value: typeof message.value === 'string' ? message.value : '', stdout: message.stdout ?? '', error: message.error });
        }
      }
    }
  }

  private async onRpc(message: HostMessage): Promise<void> {
    const fn = message.fn ?? '';
    const handler = (this.handlers as unknown as Record<string, ((args: Record<string, unknown>) => Promise<unknown>) | undefined>)[fn];
    if (!handler) {
      this.child?.stdin!.write(JSON.stringify({ type: 'rpc_result', id: message.id, error: `unknown sandbox function: ${fn}` }) + '\n');
      return;
    }
    try {
      const value = await handler(message.args ?? {});
      this.child?.stdin!.write(JSON.stringify({ type: 'rpc_result', id: message.id, value }) + '\n');
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.child?.stdin!.write(JSON.stringify({ type: 'rpc_result', id: message.id, error: text }) + '\n');
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error('Sandbox session is closed.');
    const freshSpawn = !this.child;
    if (freshSpawn) this.spawnHost();
    await this.ready;
    /* A restarted interpreter replays the last exported state; without it a
       timeout-killed run would silently drop everything the model stored. */
    const state = this.hydratePending ?? (freshSpawn ? this.lastState : null);
    if (state !== null && this.child) {
      this.hydratePending = null;
      await this.request({ type: 'hydrate', id: crypto.randomUUID(), state }, this.options.timeoutMs);
    }
  }

  private request(message: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; value?: string; stdout?: string; error?: string }> {
    const id = String(message.id);
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = timeoutMs === undefined ? null : setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Sandbox request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (result) => {
        if (timer) clearTimeout(timer);
        resolveRequest(result);
      });
      this.child?.stdin!.write(JSON.stringify(message) + '\n');
    });
  }

  async run(code: string, signal?: AbortSignal): Promise<SandboxRunResult> {
    if (signal?.aborted) return { ok: false, value: '', stdout: '', error: 'Run aborted.' };
    try {
      await this.ensureStarted();
    } catch (error) {
      return { ok: false, value: '', stdout: '', error: error instanceof Error ? error.message : String(error) };
    }
    const id = crypto.randomUUID();
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      this.kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.request({ type: 'run', id, code }, this.options.timeoutMs);
      if (aborted) return { ok: false, value: '', stdout: '', error: 'Run aborted.' };
      if (!result.ok && result.error?.startsWith('Sandbox host exited')) {
        return { ok: false, value: '', stdout: '', error: result.error };
      }
      return { ok: result.ok, value: result.value ?? '', stdout: result.stdout ?? '', error: result.error };
    } catch {
      /* The only request timeout is the run timeout, and the host is stuck, so
         the process is killed rather than left running the same program. */
      this.kill();
      return { ok: false, value: '', stdout: '', error: `Execution timed out after ${this.options.timeoutMs}ms`, timedOut: true };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async exportState(): Promise<string | null> {
    if (!this.child) return this.lastState;
    try {
      const result = await this.request({ type: 'state', id: crypto.randomUUID() }, this.options.timeoutMs);
      if (result.ok && typeof result.value === 'string') this.lastState = result.value;
    } catch {
      /* A job that cannot export keeps the previous snapshot; the checkpoint
         still carries every other field. */
    }
    return this.lastState;
  }

  hydrate(state: string): void {
    this.lastState = state;
    if (this.child) {
      void this.request({ type: 'hydrate', id: crypto.randomUUID(), state }, this.options.timeoutMs).catch(() => undefined);
    } else {
      this.hydratePending = state;
    }
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.readyResolve = null;
    if (child) {
      try {
        child.kill();
      } catch {
        /* Already gone. */
      }
    }
  }

  close(): void {
    this.closed = true;
    this.kill();
  }
}
