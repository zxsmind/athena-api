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

  try {
    await agenticResearchStream(
      job.query,
      job.history,
      (event: EngineEvent) => {
        if (controller.signal.aborted) return;
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
          setResearchJobRuntime(jobId, {
            budget: state.budgetState,
            round: state.round,
            sourceMap: state.sourceMap,
          });
          appendResearchJobEvent(jobId, { type: 'progress', data: state, timestamp: nowIso() });
        },
      },
    );
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      const after = getResearchJob(jobId);
      if (after?.status !== 'paused') cancelResearchJob(jobId);
      return;
    }
    markResearchJobFailed(jobId, error instanceof Error ? error.message : 'Research job failed');
  }

  try {
    billJob(jobId, meter);
  } finally {
    /* The job is terminal (or paused), so its concurrency slot is returned.
       Done in a finally block so a billing failure cannot leak the slot. */
    if (getResearchJob(jobId)?.status !== 'paused') meter?.releaseJobSlot(getResearchJob(jobId)?.apiKeyId ?? null);
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
