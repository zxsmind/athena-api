import { readFileSync } from 'node:fs';
import { readTrace, listTraces, deleteTrace, traceFilePath, type TraceEvent } from '../trace.js';

export interface TraceOptions {
  /** Only these event kinds. */
  kind?: string[];
  /** Include full values instead of trimming them. */
  full?: boolean;
  /** Print this many characters per field. */
  chars?: number;
  /** Job ids to include; empty means all. */
  jobs?: string[];
}

function short(value: unknown, chars: number): string {
  if (value === null || value === undefined) return '-';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  const oneLine = text.replace(/\r?\n/g, ' ⏎ ');
  return oneLine.length > chars ? `${oneLine.slice(0, chars)}… (+${oneLine.length - chars})` : oneLine;
}

function render(e: TraceEvent, chars: number): string {
  const round = e.round === undefined ? '   -' : String(e.round).padStart(3);
  const head = `${String(e.seq).padStart(4)} r${round} ${e.kind.padEnd(15)}`;
  if (!e.data || Object.keys(e.data).length === 0) return head;
  const body = Object.entries(e.data)
    .map(([k, v]) => `${k}=${short(v, chars)}`)
    .join('  ');
  return `${head}  ${body}`;
}

/**
 * Renders traces for a terminal.
 *
 * The point is to answer "what did the model do" without opening a JSON file:
 * one line per event, in order, with the fields that explain a decision. Full
 * values stay available through the raw file path that is always printed.
 */
export function runTrace(jobIds: string[], options: TraceOptions = {}): number {
  const chars = options.chars ?? (options.full ? 4_000 : 160);
  const targets = jobIds.length > 0 ? jobIds : listTraces().map((t) => t.jobId);

  if (targets.length === 0) {
    console.log('No traces found. Enable logging.trace in config.yaml and run a research job.');
    return 0;
  }

  let printed = 0;
  for (const jobId of targets) {
    let events: TraceEvent[];
    try {
      events = readTrace(jobId);
    } catch {
      console.log(`[${jobId}] trace could not be read`);
      continue;
    }
    if (options.kind && options.kind.length > 0) {
      const wanted = new Set(options.kind);
      events = events.filter((e) => wanted.has(e.kind));
    }
    console.log(`\n=== trace ${jobId} (${events.length} events) ===`);
    for (const e of events) {
      console.log(render(e, chars));
      printed += 1;
    }
    console.log(`raw: ${traceFilePath(jobId)}`);
  }
  if (printed === 0) console.log('(no events matched)');
  return printed;
}

/** Follows a trace while it is being written. Used during a live run. */
export function followTrace(jobId: string, pollMs = 1_000): void {
  let seen = 0;
  const tick = (): void => {
    let events: TraceEvent[] = [];
    try {
      events = readTrace(jobId);
    } catch {
      return;
    }
    for (const e of events.slice(seen)) console.log(render(e, 160));
    seen = events.length;
  };
  tick();
  setInterval(tick, pollMs).unref();
}

export function traceSummary(jobId: string): string {
  const events = readTrace(jobId);
  if (events.length === 0) return `No trace events for ${jobId}.`;
  const byKind = new Map<string, number>();
  for (const e of events) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  const end = events.find((e) => e.kind === 'run.end');
  const lines = [`${jobId}: ${events.length} events`];
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) lines.push(`  ${kind.padEnd(16)} ${count}`);
  if (end?.data) {
    lines.push(`  outcome=${end.data.outcome} answer_chars=${end.data.answer_chars} tokens=${end.data.tokens_used}/${end.data.token_limit} exhausted_by=${end.data.exhausted_by ?? 'none'}`);
  }
  return lines.join('\n');
}

export function clearTrace(jobId: string): string {
  return deleteTrace(jobId)
    ? `Deleted trace ${jobId} (${traceFilePath(jobId)})`
    : `No trace file for ${jobId}`;
}

export function listTraceFiles(): string {
  const traces = listTraces();
  if (traces.length === 0) return 'No traces found.';
  const lines = ['job id                                  events      size'];
  for (const t of traces) {
    lines.push(`${t.jobId.padEnd(38)} ${String(t.events).padStart(6)}  ${(t.bytes / 1024).toFixed(1)} KB`);
  }
  return lines.join('\n');
}

export function rawTrace(jobId: string): string {
  return readFileSync(traceFilePath(jobId), 'utf-8');
}
