import type { ResearchLedger } from './research-ledger.js';
import type { ResearchPreset } from './modes.js';

export interface DeepResearchState {
  ledger: ResearchLedger;
  preset: ResearchPreset;
  /** Model that served the last LLM call. Used to resolve the context window
   *  for offload triggers, with the route primary as the fallback while
   *  nothing has served yet. */
  lastUsed?: { providerId: string; model: string };
  /** Set when the model recalled a cleared source. The next round start runs
   *  an offload pass and resets it. No threshold: the recall itself is the signal. */
  recallPendingClear?: boolean;
}

/**
 * The dedup guard is server-side: the engine refuses a repeated search or fetch
 * before spending a credit, so the model never has to be told what it already
 * ran. That is why no ledger text reaches the prompt.
 */
