import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDataPath } from './storage.js';
import { logger } from './logger.js';

/**
 * Per-job execution trace, written as JSON Lines.
 *
 * The log file answers "did the request succeed"; it cannot answer "what did the
 * model actually think, which route did it pick, what did it send to the
 * provider, and why did it stop". Those questions only get answered by
 * recording the run as it happens, which is what this does.
 *
 * One JSON object per line, appended as the run proceeds, so a live tail works
 * on a job that is still going. Off by default: a trace can contain API keys and
 * full page content, so it is opt-in and lives outside the source tree.
 */
export type TraceEventKind =
  | 'run.start'
  | 'run.end'
  | 'round.start'
  | 'llm.attempt'
  | 'llm.error'
  /* A provider call retried after a rate limit or a transient failure. */
  | 'llm.retry'
  | 'llm.response'
  | 'tool.call'
  | 'tool.result'
  | 'tool.skipped'
  /* One sandbox program: its label, outcome, and how much text it returned. */
  | 'code.result'
  /* One injected call inside a program: which function, what it asked for, and
     how much came back. Without this the trace cannot say whether a program
     actually read a page or only searched. */
  | 'code.rpc'
  | 'plan.create'
  | 'plan.edit'
  | 'plan.read'
  /* A note the model published with report_progress. Carries call_id so a
     resumed run can replay what the user was already shown. */
  | 'progress'
  | 'compaction'
  | 'budget'
  | 'cooldown'
  /* The system prompt as assembled for this run, written once. It is built from
     four sources that vary with mode, response length and date, so a trace that
     recorded only the query could not explain a behaviour by pointing at the
     instruction that produced it. */
  | 'prompt.assembled'
  | 'note';

export interface TraceEvent {
  seq: number;
  at: string;
  kind: TraceEventKind;
  jobId: string;
  round?: number;
  data?: Record<string, unknown>;
}

export interface TraceLimits {
  /** Bytes after which a line is truncated. Keeps one runaway page from
   *  producing a multi-megabyte trace line. */
  maxValueChars: number;
  /** Hard cap per event kind, so a retry loop cannot fill the disk. */
  maxEventsPerKind: number;
}

const DEFAULTS: TraceLimits = { maxValueChars: 4_000, maxEventsPerKind: 5_000 };

const active = new Map<string, { count: number; byKind: Map<string, number> }>();
let enabled = false;
let limits: TraceLimits = { ...DEFAULTS };

function tracesDir(): string {
  return getDataPath('traces');
}

function tracePath(jobId: string): string {
  return resolve(tracesDir(), `${jobId}.jsonl`);
}

/**
 * Human-readable live log next to the JSONL. Same events, full fidelity: the
 * JSONL clips values at `maxValueChars` to stay machine-readable and bounded,
 * so a complete prompt, answer, or page can never be recovered from it. The
 * live log carries everything unclipped — every round's input, output,
 * reasoning, tool calls and results — appended as it happens, so `tail -f`
 * shows the run while it is still going. Same opt-in flag, same directory,
 * deleted together with the trace.
 */
export function liveLogPath(jobId: string): string {
  return resolve(tracesDir(), `${jobId}.live.log`);
}

export function traceLive(jobId: string, title: string, body: string): void {
  if (!enabled) return;
  try {
    mkdirSync(tracesDir(), { recursive: true });
    appendFileSync(liveLogPath(jobId), `===== ${title} =====\n${body}\n\n`, 'utf-8');
  } catch (err) {
    logger.warn('live log write failed', { jobId, error: (err as Error).message });
  }
}

function clip(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    return value.length > limits.maxValueChars
      ? `${value.slice(0, limits.maxValueChars)}… [${value.length} chars total]`
      : value;
  }
  /* `messages_full` is the recorded conversation and is handed over unclipped.
     Its tool results are whole pages, and at 4,000 characters a page was cut
     exactly where it stopped carrying the sentence a reader needed: every long
     fetch landed on the same ceiling, so a trace could show what the model asked
     for and never what it got back. A run whose answer was wrong because of
     something on a page could not be diagnosed from this file at all.

     The key is checked as well as the shape. Matching only on `role` present
     would exempt any list of role-shaped objects elsewhere in an event, which is
     a hole rather than an exemption. */
  if (key === 'messages_full') return value;
  if (Array.isArray(value)) return value.map((entry) => clip(entry));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = clip(v, k);
    return out;
  }
  return value;
}

/** Turns on tracing for the rest of the process. */
export function enableTrace(options: Partial<TraceLimits> = {}): void {
  enabled = true;
  limits = { ...DEFAULTS, ...options };
}

/**
 * Records one event. Never throws: a trace failure must not fail a research job.
 * Returns the written event, or null when tracing is off or the cap was hit.
 */
export function traceEvent(
  jobId: string,
  kind: TraceEventKind,
  data?: Record<string, unknown>,
  round?: number,
): TraceEvent | null {
  if (!enabled) return null;
  let state = active.get(jobId);
  if (!state) {
    state = { count: 0, byKind: new Map() };
    active.set(jobId, state);
  }
  const kindCount = state.byKind.get(kind) ?? 0;
  if (kindCount >= limits.maxEventsPerKind) return null;
  state.byKind.set(kind, kindCount + 1);
  state.count += 1;

  const event: TraceEvent = {
    seq: state.count,
    at: new Date().toISOString(),
    kind,
    jobId,
    ...(round === undefined ? {} : { round }),
    ...(data ? { data: clip(data) as Record<string, unknown> } : {}),
  };
  try {
    mkdirSync(tracesDir(), { recursive: true });
    appendFileSync(tracePath(jobId), `${JSON.stringify(event)}\n`, 'utf-8');
  } catch (err) {
    logger.warn('trace write failed', { jobId, kind, error: (err as Error).message });
  }
  return event;
}

export function readTrace(jobId: string): TraceEvent[] {
  const path = tracePath(jobId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as TraceEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is TraceEvent => e !== null);
}

export function listTraces(): { jobId: string; bytes: number; events: number }[] {
  if (!existsSync(tracesDir())) return [];
  return readdirSync(tracesDir())
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const jobId = name.replace(/\.jsonl$/, '');
      const events = readTrace(jobId).length;
      let bytes = 0;
      try {
        bytes = readFileSync(tracePath(jobId)).byteLength;
      } catch { /* ignore */ }
      return { jobId, bytes, events };
    })
    .sort((a, b) => a.jobId.localeCompare(b.jobId));
}

export function deleteTrace(jobId: string): boolean {
  const path = tracePath(jobId);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  try {
    rmSync(liveLogPath(jobId), { force: true });
  } catch { /* live log may never have been written */ }
  active.delete(jobId);
  return true;
}

export function traceFilePath(jobId: string): string {
  return tracePath(jobId);
}

/**
 * Deletes trace files older than `maxAgeMs`, by file mtime. Jobs still in
 * `spareIds` keep their files even when stale: a paused job writes nothing
 * while it waits, and deleting its trace would blind `athena trace`.
 * Returns the pruned job ids.
 */
export function pruneOldTraces(maxAgeMs: number, spareIds: Set<string> = new Set(), nowMs: number = Date.now()): string[] {
  if (maxAgeMs <= 0 || !existsSync(tracesDir())) return [];
  const ids = new Set<string>();
  for (const name of readdirSync(tracesDir())) {
    if (name.endsWith('.jsonl')) ids.add(name.replace(/\.jsonl$/, ''));
    else if (name.endsWith('.live.log')) ids.add(name.replace(/\.live\.log$/, ''));
  }
  const pruned: string[] = [];
  for (const jobId of ids) {
    if (spareIds.has(jobId)) continue;
    /* Newest write of either file: a job is stale only when both went quiet. */
    let mtime = Number.NaN;
    for (const file of [tracePath(jobId), liveLogPath(jobId)]) {
      try {
        const t = statSync(file).mtimeMs;
        mtime = Number.isFinite(mtime) ? Math.max(mtime, t) : t;
      } catch {
        /* A file may vanish between listing and stat; the other decides. */
      }
    }
    if (!Number.isFinite(mtime) || nowMs - mtime <= maxAgeMs) continue;
    deleteTrace(jobId);
    try {
      /* deleteTrace only removes the live log alongside a jsonl; a lone live
         log needs its own call. */
      rmSync(liveLogPath(jobId), { force: true });
    } catch { /* ignore */ }
    pruned.push(jobId);
  }
  return pruned;
}
