/**
 * Sandbox boundary. A session runs model-written programs in a persistent
 * interpreter; every effect the program has on the outside world travels back
 * to the engine as an RPC against one of these handlers.
 *
 * The backend never decides what a `search` or `extract` means: it forwards
 * `{fn, args}` and returns whatever the handler returns. Budget, source
 * numbering, evidence and trace all live on the engine side.
 */

export interface SandboxHandlers {
  search(args: Record<string, unknown>): Promise<unknown>;
  extract(args: Record<string, unknown>): Promise<unknown>;
  read_source(args: Record<string, unknown>): Promise<unknown>;
  plan(args: Record<string, unknown>): Promise<unknown>;
  plan_update(args: Record<string, unknown>): Promise<unknown>;
  plan_read(args: Record<string, unknown>): Promise<unknown>;
  budget(args: Record<string, unknown>): Promise<unknown>;
  decline(args: Record<string, unknown>): Promise<unknown>;
}

export interface SandboxRunResult {
  ok: boolean;
  /** Return value of the program, serialised and clipped. */
  value: string;
  /** Whatever the program printed, clipped. */
  stdout: string;
  error?: string;
  /** True when the run was killed by `timeoutMs`, not by a program error. */
  timedOut?: boolean;
}

export interface SandboxSession {
  /** Handlers change every round; the session keeps the latest. */
  setHandlers(handlers: SandboxHandlers): void;
  run(code: string, signal?: AbortSignal): Promise<SandboxRunResult>;
  /** The program's explicit `state` as JSON, or null before any run. */
  exportState(): Promise<string | null>;
  /** Restores a previously exported `state`. Applies on the next run. */
  hydrate(state: string): void;
  close(): void;
}
