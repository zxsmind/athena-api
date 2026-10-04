import { getConfig } from '../config/load.js';
import { traceEvent } from '../trace.js';
import { clearEligibleMessages } from './stubs.js';
import {
  compactionTier,
  estimateContextTokens,
  researchRoutePrimary,
  resolveContextWindow,
} from './triggers.js';
import type { DeepResearchState } from './context-blocks.js';

export interface CompactableMessage {
  role: string;
  content?: string | null;
  tool_calls?: { function: { name: string; arguments: string } }[];
}

/**
 * Tier 1 orchestrator: window-aware lossless offload. Raw tool results move to
 * the Evidence Store behind stubs. Nothing is summarised, nothing is deleted
 * without a stored copy.
 */

/**
 * Runs one offload pass if the usage calls for it.
 *
 * @param emergency when true, clears down ignoring recency (used after a
 * provider overflow error, before a single retry).
 * @returns true when anything was stubbed.
 */
export function runCompactionTier(
  messages: CompactableMessage[],
  deepState: DeepResearchState,
  jobId: string,
  round: number,
  emergency: boolean,
): boolean {
  const cfg = getConfig().compaction;
  const window = resolveContextWindow(researchRoutePrimary(deepState.preset.mode), deepState.lastUsed ?? null);
  const usageBefore = estimateContextTokens(messages);

  if (window === null && !emergency) {
    /* No window, no trigger. The emergency retry below is the only backstop,
       and the trace says why proactive offload could not run. */
    traceEvent(jobId, 'compaction', {
      tier: 'skipped',
      reason: 'unknown window',
      usage_estimate_tokens: usageBefore,
    }, round);
    return false;
  }

  const tier = emergency ? 'hard' : compactionTier(usageBefore, cfg.triggerTokens, window, deepState.preset.mode);
  if (tier === 'none') return false;

  const keepRounds = emergency ? 0 : cfg.keepRecentRounds;
  const cleared = clearEligibleMessages(messages, jobId, round, keepRounds);
  const usageAfter = estimateContextTokens(messages);

  traceEvent(jobId, 'compaction', {
    tier: emergency ? 'emergency' : tier,
    usage_before_tokens: usageBefore,
    usage_after_tokens: usageAfter,
    window_tokens: window,
    trigger_tokens: cfg.triggerTokens,
    cleared_messages: cleared.clearedMessages,
    stubbed_sources: cleared.stubbedSources,
  }, round);
  return cleared.clearedMessages > 0;
}

/**
 * Runs one offload pass after a recall. No threshold is consulted: the recall
 * itself proved the working set stale. The recalled text arrived this round as
 * a fresh message, so it is never eligible for the pass it triggers.
 */
export function runRecallClear(
  messages: CompactableMessage[],
  jobId: string,
  round: number,
): boolean {
  const usageBefore = estimateContextTokens(messages);
  const cleared = clearEligibleMessages(
    messages, jobId, round, getConfig().compaction.keepRecentRounds,
  );
  if (cleared.clearedMessages === 0) return false;
  traceEvent(jobId, 'compaction', {
    tier: 'recall',
    usage_before_tokens: usageBefore,
    usage_after_tokens: estimateContextTokens(messages),
    cleared_messages: cleared.clearedMessages,
    stubbed_sources: cleared.stubbedSources,
  }, round);
  return true;
}
