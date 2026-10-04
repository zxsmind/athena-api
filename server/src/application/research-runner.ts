import { agenticResearchStream } from '../engine.js';
import type { EngineEvent } from '../engine.js';
import { listResearchCheckpoints } from '../engine/checkpoint.js';
import { budgetSnapshot, resolveResearchPreset } from '../engine/modes.js';
import type { Meter } from './meter.js';
import {
  appendResearchJobEvent,
  applyAPISettings,
  attachResearchJobController,
  cancelResearchJob,
  getResearchJob,
  markResearchJobDeclined,
  markResearchJobDone,
  markResearchJobFailed,
  markResearchJobRunning,
  registerRecoveredJob,
  setResearchJobFinalContext,
  setResearchJobRuntime,
  setResearchJobStatus,
  type ResearchJobStatus,
} from '../research-jobs.js';
import { getConfig } from '../config/load.js';
import { callLLM } from '../llm.js';

/** Engine step kinds that map onto a finer-grained job status. */
const STEP_TO_STATUS: Record<string, ResearchJobStatus> = {
  plan: 'planning',
  search: 'searching',
  analyze: 'searching',
  review: 'reviewing',
  synthesize: 'synthesizing',
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Evidence chars a salvage answer may read. Enough for dozens of snippets. */
const SALVAGE_EVIDENCE_CHARS = 30_000;
/** One bounded call: salvage must not become a second run. */
const SALVAGE_TIMEOUT_MS = 300_000;

/**
 * Best-effort answer from gathered evidence after a stall killed the run.
 * Returns false when there is nothing to write from or the call itself
 * fails — then the stall error stands and nothing is hidden.
 */
async function salvageStalledJob(jobId: string): Promise<boolean> {
  const job = getResearchJob(jobId);
  const sources = job?.runtime?.sourceMap ?? [];
  if (!job || job.status === 'cancelled' || sources.length === 0) return false;
  const lines: string[] = [];
  let chars = 0;
  for (const source of sources) {
    const block = `[${source.source_index}] ${source.title ?? source.url}\n${source.url}\n${(source.snippet ?? '').slice(0, 1200)}`;
    if (chars + block.length > SALVAGE_EVIDENCE_CHARS) break;
    lines.push(block);
    chars += block.length;
  }
  if (lines.length === 0) return false;
  try {
    const answer = await callLLM({
      label: 'salvage-answer',
      role: job.mode,
      messages: [
        {
          role: 'system',
          content: 'Answer from the evidence below with inline [N] citations. State plainly what the evidence does not cover.',
        },
        { role: 'user', content: `Question: ${job.query}\n\nEvidence:\n${lines.join('\n\n')}` },
      ],
      reasoningEffort: 'low',
      signal: AbortSignal.timeout(SALVAGE_TIMEOUT_MS),
    });
    const text = (answer.fullContent ?? '').trim();
    if (!text) return false;
    markResearchJobDone(jobId, {
      query: job.query,
      answer: `${text}\n\n[Partial answer: the run stalled, so this was written from the evidence gathered so far.]`,
      sources: sources.map((source) => ({
        source_index: source.source_index,
        title: source.title,
        url: source.url,
        domain: source.domain,
      })),
      steps: [],
      results_count: sources.length,
      elapsed_ms: Date.now() - Date.parse(job.startedAt ?? job.createdAt),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one research job to a terminal state. Engine events are translated into
 * persisted job events here, so the engine itself stays free of storage concerns.
 *
 * The job is billed once it reaches a terminal state, from its own counters. A
 * running job is never interrupted by a budget decision.
 */
export async function runResearchJob(jobId: string, meter?: Meter): Promise<void> {
  const job = markResearchJobRunning(jobId);
  if (!job) return;

  const controller = new AbortController();
  attachResearchJobController(jobId, controller);

  /* Stall watchdog. Every timeout below watches a step that can end; this
     watches the run itself. A broken stream, a hung sandbox RPC, or a model
     that never answers all look identical from here — silence — and without
     this the job sits forever while its budget is already spent
     (`j-pXSYgnHv7IIq`: 3h on one dead round). The abort asks cooperating code
     to stop; the race guarantees the runner moves on even when nothing
     cooperates (an await on a never-settling promise ignores abort). On
     stall the gathered evidence still buys one bounded salvage answer before
     the run is marked failed, so a dead round costs minutes, not the run. */
  const stallMs = getConfig().research.stallTimeoutMs;
  let lastActive = Date.now();
  let lastEvent = 'start';
  let stalled = false;
  let stallReject: ((error: Error) => void) | null = null;
  const watchdog = setInterval(() => {
    if (stalled) return;
    if (Date.now() - lastActive > stallMs) {
      stalled = true;
      const error = new Error(
        `Stalled: no engine progress for ${Math.round(stallMs / 60000)}m (last event: ${lastEvent})`,
      );
      controller.abort(error);
      stallReject?.(error);
    }
  }, Math.min(30_000, Math.max(25, Math.floor(stallMs / 4))));

  try {
    const stream = agenticResearchStream(
      job.query,
      job.history,
      (event: EngineEvent) => {
        if (controller.signal.aborted) return;
        lastActive = Date.now();
        lastEvent = event.type;
        switch (event.type) {
          case 'step': {
            appendResearchJobEvent(jobId, { type: 'step', data: event.data, timestamp: nowIso() });
            const granular = STEP_TO_STATUS[event.data.type];
            if (granular) setResearchJobStatus(jobId, granular);
            break;
          }
          case 'token':
            appendResearchJobEvent(jobId, { type: 'token', text: event.text, timestamp: nowIso() });
            break;
          case 'progress': {
            /* A progress note the model published with report_progress. Without
               this case the note reached the CLI console and nothing else: the
               engine emitted it, the runner dropped it, and the SSE consumer
               never saw it. It is stored under its own event type because the
               job's `progress` event already carries the runtime state. */
            appendResearchJobEvent(jobId, { type: 'progress_note', data: event.data, timestamp: nowIso() });
            break;
          }
          case 'sources':
            appendResearchJobEvent(jobId, { type: 'sources', sources: event.sources, timestamp: nowIso() });
            break;
          case 'context':
            appendResearchJobEvent(jobId, { type: 'context', finalContext: event.finalContext, timestamp: nowIso() });
            setResearchJobFinalContext(jobId, event.finalContext);
            break;
          case 'done':
            markResearchJobDone(jobId, event.response);
            break;
          case 'declined':
            markResearchJobDeclined(jobId, event.reason);
            break;
          case 'error':
            markResearchJobFailed(jobId, event.message, event.finalContext);
            break;
        }
      },
      job.mode,
      {
        signal: controller.signal,
        preset: job.preset,
        jobId: job.id,
        mode: job.mode,
        responseLength: job.responseLength,
        verbosity: job.verbosity,
        researchApi: job.researchApi,
        onProgress: (state) => {
          lastActive = Date.now();
          lastEvent = 'progress';
          setResearchJobRuntime(jobId, {
            budget: state.budgetState,
            round: state.round,
            sourceMap: state.sourceMap,
          });
          appendResearchJobEvent(jobId, { type: 'progress', data: state, timestamp: nowIso() });
        },
      },
    );
    await Promise.race([
      stream,
      new Promise<never>((_, reject) => {
        stallReject = reject;
      }),
    ]);
  } catch (error: unknown) {
    if (stalled) {
      /* The evidence already paid for still has value: one bounded call turns
         it into a marked partial answer instead of a total loss. */
      const salvaged = await salvageStalledJob(jobId);
      if (!salvaged) {
        markResearchJobFailed(jobId, error instanceof Error ? error.message : 'Research job stalled');
      }
    } else if (controller.signal.aborted) {
      const after = getResearchJob(jobId);
      if (after?.status !== 'paused') cancelResearchJob(jobId);
      return;
    } else {
      markResearchJobFailed(jobId, error instanceof Error ? error.message : 'Research job failed');
    }
  } finally {
    clearInterval(watchdog);
  }

  try {
    billJob(jobId, meter);
  } finally {
    /* A paused job does no work, so it holds no slot: resume re-acquires one
       and fails honestly when the key is full. Holding a slot through a
       pause let one forgotten job halve a free plan's capacity. */
    meter?.releaseJobSlot(getResearchJob(jobId)?.apiKeyId ?? null);
  }
}

/**
 * Debits the job's key from the counters the run actually produced. Tokens are
 * billed only when the provider reported usage.
 */
function billJob(jobId: string, meter: Meter | undefined): void {
  if (!meter) return;
  const finished = getResearchJob(jobId);
  if (!finished?.runtime?.budget || finished.status === 'paused') return;
  const budget = finished.runtime.budget;
  const snapshot = budgetSnapshot(budget, resolveResearchPreset(finished.mode));
  /* The ledger only holds calls whose usage the provider actually reported, so
     its presence is the honest signal. A run without it is billed for searches
     and page reads only, never for guessed tokens. */
  const reportedTokens = Object.keys(budget.tokenLedger).length > 0;
  meter.chargeResearch(finished.apiKeyId ?? null, snapshot, reportedTokens);
}

/**
 * Restores jobs that were interrupted by a restart. A job with a checkpoint is
 * restored paused and must be resumed explicitly; nothing is restarted silently.
 */
export function recoverInterruptedResearchJobs(): void {
  for (const checkpoint of listResearchCheckpoints()) {
    if (getResearchJob(checkpoint.jobId)) continue;
    const job = registerRecoveredJob(checkpoint);
    console.log(`[checkpoint] restored job ${job.id} as paused (${job.mode}); resume it explicitly`);
  }
}

/** Applies storage ceilings from configuration to the job registry. */
export function applyRuntimeLimits(): void {
  const storage = getConfig().storage;
  applyAPISettings({ maxActiveJobs: storage.maxActiveJobs, maxEventsPerJob: storage.maxEventsPerJob });
}
