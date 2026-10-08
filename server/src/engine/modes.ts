import { getConfig } from '../config/load.js';
import type { ResearchModeConfig } from '../config/schema.js';

/**
 * Research modes, ordered from cheapest to most thorough. This is the single
 * effort axis: each mode names its own ceilings in `config.modes`. There is no
 * second "budget profile" selector, because it only duplicated this one.
 */
export const RESEARCH_MODES = ['instant', 'default', 'deep', 'max'] as const;
export type ResearchMode = typeof RESEARCH_MODES[number];

/** The mode used when a request does not ask for one. */
export const DEFAULT_RESEARCH_MODE: ResearchMode = 'default';

/**
 * Reasoning effort is not a request parameter. It follows the mode, so a caller
 * cannot ask for a cheap mode and an expensive thinking budget at the same time.
 * These are provider wire values, and every provider that receives one has to
 * understand it; providers that only accept `none` and `default` are handled
 * where the request is built.
 */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'xhigh'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export const REASONING_EFFORT_BY_MODE = {
  instant: 'none',
  default: 'low',
  deep: 'medium',
  max: 'xhigh',
} as const satisfies Record<ResearchMode, ReasoningEffort>;

/** The effort a mode runs at. Never taken from the request. */
export function reasoningEffortForMode(mode: ResearchMode): ReasoningEffort {
  return REASONING_EFFORT_BY_MODE[mode];
}

/**
 * How long the answer should be. A second axis from the research mode: the mode
 * decides how much evidence to gather, this decides how much of it to write.
 */
export const RESPONSE_LENGTHS = ['short', 'long', 'exhaustive'] as const;
export type ResponseLength = typeof RESPONSE_LENGTHS[number];

/**
 * The length used when a request does not ask for one.
 *
 * `long` because it is what the default used to mean before verbosity did this
 * job. `short` answers too little for a paid request, `exhaustive` costs a full
 * research run to read.
 */
export const DEFAULT_RESPONSE_LENGTH: ResponseLength = 'long';

/**
 * What the consumer sees while the job runs.
 *
 * A separate axis from response length, and separate from the mode. `summary`
 * shows the progress notes only; `detailed` adds the model's raw reasoning.
 * Neither changes what the model writes.
 */
export const RESEARCH_VERBOSITIES = ['summary', 'detailed'] as const;
export type ResearchVerbosity = typeof RESEARCH_VERBOSITIES[number];

/** The verbosity used when a request does not ask for one. */
export const DEFAULT_RESEARCH_VERBOSITY: ResearchVerbosity = 'detailed';

/**
 * Rejects an unrecognised mode instead of falling back.
 *
 * A silent fallback would resolve the ceilings of a different mode, or none at
 * all, which removes the spend limits without anyone noticing. Only use this
 * where the value did not already pass the request schema; everything reaching
 * an HTTP route goes through `z.enum(RESEARCH_MODES)` first.
 */
export function assertResearchMode(value: unknown): ResearchMode {
  if (typeof value === 'string' && (RESEARCH_MODES as readonly string[]).includes(value)) {
    return value as ResearchMode;
  }
  throw new Error(
    `Unknown research mode "${String(value)}". Use one of: ${RESEARCH_MODES.join(', ')}.`,
  );
}

export type ResearchPreset = ResearchModeConfig & {
  mode: ResearchMode;
};

export function resolveResearchPreset(mode: ResearchMode): ResearchPreset {
  /* `max` used to set `auditAnswer`, which ran a second model over the finished
     answer and deleted claims it could not confirm from a 400-character snippet.
     That is gone; a mode now carries its ceilings and nothing else. */
  return { ...getConfig().modes[mode], mode };
}

/** Which ceiling stopped a job. A job always terminates with one visible reason. */
export type StopReason =
  | 'search_calls'
  | 'fetch_calls'
  | 'tokens'
  | 'wall_clock'
  | 'steps'
  | 'turn_guard';

/** Provider-reported tokens for one model, split by billing category. */
export interface TokenUsageByModel {
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
  /** Why the call was made. Absent for research calls. */
  purpose?: string;
}

export interface BudgetState {
  usedSearchCalls: number;
  usedFetchCalls: number;
  /** Milliseconds of sandbox execution time used. Code engine only. */
  usedCpuMs: number;
  /** Billable tokens: what the job is charged for, cache reads excluded. */
  usedTokens: number;
  /** Everything the provider reported, cache reads included. */
  usedTotalTokens: number;
  startedAt: number;
  usedSteps: number;
  usedTurns: number;
  exhaustedBy: StopReason | null;
  /** Per-model usage, so billing can price each call with its own rate. */
  tokenLedger: Record<string, TokenUsageByModel>;
}

export function createBudgetState(now: number = Date.now()): BudgetState {
  return {
    usedSearchCalls: 0,
    usedFetchCalls: 0,
    usedCpuMs: 0,
    usedTokens: 0,
    usedTotalTokens: 0,
    startedAt: now,
    usedSteps: 0,
    usedTurns: 0,
    exhaustedBy: null,
    tokenLedger: {},
  };
}

export function elapsedMs(state: BudgetState, now: number = Date.now()): number {
  return Math.max(0, now - state.startedAt);
}

export function remainingSearchCalls(state: BudgetState, preset: ResearchPreset): number {
  return Math.max(0, preset.maxSearchCalls - state.usedSearchCalls);
}

export function remainingFetchCalls(state: BudgetState, preset: ResearchPreset): number {
  return Math.max(0, preset.maxFetchCalls - state.usedFetchCalls);
}

export function remainingTokens(state: BudgetState, preset: ResearchPreset): number {
  return Math.max(0, preset.maxBillableTokens - state.usedTokens);
}

export function remainingWallClockMs(state: BudgetState, preset: ResearchPreset, now: number = Date.now()): number {
  return Math.max(0, preset.maxWallClockMs - elapsedMs(state, now));
}

/**
 * Output-side budgets for the forced final answer, by requested length.
 *
 * These are not a prediction of how long a round takes. They are the wall clock
 * the report itself needs to be written, which is the largest output of the
 * run, and their only job here is to tell the run when to stop researching.
 */
export const FINAL_ANSWER_TIMEOUT_MS = {
  short: 240_000,
  long: 540_000,
  exhaustive: 900_000,
} as const satisfies Record<ResponseLength, number>;

/**
 * Floor for any model call's deadline. Below this the only question left is
 * whether the provider answers at all, and a short boring wait answers that as
 * cheaply as a wrong answer can be. It also caps how far a job may run past its
 * own promise at the tail, since the answer is never given less than this.
 */
export const MIN_CALL_DEADLINE_MS = 30_000;

/**
 * Wall clock held back from research rounds so the final answer can be written.
 *
 * An instant job promises five minutes in total, so reserving the nine minutes
 * an exhaustive report asks for would leave nothing to research with. The
 * reserve therefore never exceeds half of what the mode promised: a structural
 * split of the promise, not a guess about latency.
 */
export function answerReserveMs(preset: ResearchPreset, responseLength: ResponseLength): number {
  return Math.min(FINAL_ANSWER_TIMEOUT_MS[responseLength], Math.floor(preset.maxWallClockMs / 2));
}

/**
 * True once what is left of the promise belongs to the answer rather than to
 * another round of research.
 */
export function answerWindowReserved(
  state: BudgetState,
  preset: ResearchPreset,
  responseLength: ResponseLength,
  now: number = Date.now(),
): boolean {
  return remainingWallClockMs(state, preset, now) <= answerReserveMs(preset, responseLength);
}

/**
 * Deadline for one model call in a research run.
 *
 * The caller's job budget is the only bound: the mode already promised the API
 * caller a wall clock, and a per-round constant contradicted it (a deep run was
 * killed at two minutes against a ninety-minute promise). Streaming calls add
 * the idle timer on top, which is liveness rather than a prediction, because
 * every chunk resets it.
 */
export function callDeadlineMs(
  state: BudgetState,
  preset: ResearchPreset,
  responseLength: ResponseLength,
  finalAnswer: boolean,
  now: number = Date.now(),
): number {
  const remaining = remainingWallClockMs(state, preset, now);
  /* The forced answer is the last call a job makes, so it gets everything that
     is left. A research round leaves the answer's window alone. */
  const usable = finalAnswer ? remaining : remaining - answerReserveMs(preset, responseLength);
  return Math.max(MIN_CALL_DEADLINE_MS, usable);
}

/** The first ceiling reached, or null while the job may continue. */
export function checkCeilings(
  state: BudgetState,
  preset: ResearchPreset,
  now: number = Date.now(),
): StopReason | null {
  if (elapsedMs(state, now) >= preset.maxWallClockMs) return 'wall_clock';
  if (state.usedSteps >= preset.maxSteps) return 'steps';
  if (state.usedSearchCalls >= preset.maxSearchCalls) return 'search_calls';
  if (state.usedFetchCalls >= preset.maxFetchCalls) return 'fetch_calls';
  if (state.usedTokens >= preset.maxBillableTokens) return 'tokens';
  return null;
}

/** Tool calls after which the wrap-up message is sent. A mode overrides the
 *  global fallback; reading it in one place keeps the two engines in step. */
export function wrapUpToolCallThreshold(preset: ResearchPreset): number {
  return preset.wrapUpToolCalls ?? getConfig().research.wrapUpToolCalls;
}

/** Warn while tools are still available, even when one call per turn would
 *  otherwise reach the wrap-up threshold together with the step ceiling. */
export function shouldWrapUp(state: BudgetState, preset: ResearchPreset, toolCalls: number): boolean {
  return toolCalls >= wrapUpToolCallThreshold(preset)
    || (state.usedSteps > 0 && state.usedSteps + 1 >= preset.maxSteps);
}

export function chargeSearchCalls(state: BudgetState, count: number): void {
  state.usedSearchCalls += count;
}

export function chargeFetchCalls(state: BudgetState, count: number): void {
  state.usedFetchCalls += count;
}

/** Adds sandbox execution time. Wall-clock of the run, not CPU cycles: the
 *  interpreter is single-threaded per job, so the distinction buys nothing. */
export function chargeCpuMs(state: BudgetState, ms: number): void {
  state.usedCpuMs += Math.max(0, ms);
}

/**
 * Charges a call against the job's spend ceiling.
 *
 * `billable` is the caller's already-computed billable total, not the raw
 * provider total. Cache reads must be excluded by the caller: they re-read a
 * prefix the provider already holds and are priced at a fraction of a fresh
 * input token, so charging them at face value would stop a long job for work it
 * did not actually pay for.
 */
export function chargeTokens(state: BudgetState, billable: number): void {
  state.usedTokens += Math.max(0, billable);
}

/** Adds to the raw provider-reported total, which is what a cost view shows. */
export function chargeTotalTokens(state: BudgetState, total: number): void {
  state.usedTotalTokens += Math.max(0, total);
}

/** Provider usage as both engines receive it; structural so modes.ts owns no
 *  dependency on the model transport. */
export interface UsageCharge {
  reported: boolean;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Charges one model call. This is the single home of the billable rule:
 * `total − cacheRead`, because cache reads re-read a prefix the provider
 * already holds and are priced at a fraction of a fresh input token. It lived
 * in both engines before, which is how a billing rule starts to drift.
 */
export function chargeUsage(state: BudgetState, usage: UsageCharge, providerId: string, modelId: string): void {
  if (!usage.reported) return;
  chargeTokens(state, usage.totalTokens - usage.cacheReadTokens);
  chargeTotalTokens(state, usage.totalTokens);
  recordTokenUsage(state, {
    providerId,
    modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
}

/**
 * The message that asks for the final answer before a ceiling forces it. Both
 * engines send this exact text; the wording is a contract with the prompt's
 * stopping rule, so it has one home.
 */
export const WRAP_UP_MESSAGE = '[wrap-up] Research is approaching its execution limits. Prioritise the original request: finish only the evidence checks that determine the answer, then write the final answer from the sources already gathered. Clearly mark any unresolved gaps.';

/**
 * One-time retirement notices. A spent search or fetch allowance retires only
 * its own tool; the run continues on the other allowance while steps, tokens,
 * and time remain. Only hard ceilings (wall clock, steps, tokens) and both
 * allowances out remove the tools and force the answer.
 */
export const SEARCH_RETIRED_MESSAGE = 'Search allowance for this job is spent. Continue reading what you found with fetch_url; do not ask for more searches.';

export const FETCH_RETIRED_MESSAGE = 'Page-read allowance for this job is spent. Further searches return snippets only; answer when the evidence suffices.';

/**
 * Sent once when the remaining wall clock has shrunk to the answer's window.
 *
 * Wall clock is the one ceiling a reasoning round can spend a long time inside
 * without noticing: the model is answering, it is just thinking. Rounds now
 * leave the reserve alone, so without this notice a run would keep researching
 * until its promise was gone and have nothing left to write with.
 */
export const ANSWER_WINDOW_MESSAGE = '[answer-window] The remaining time for this job is reserved for writing the final answer. Stop researching and answer now from the evidence already gathered. Cite supported claims with [N] and state explicitly what could not be confirmed.';

/**
 * Code-engine wordings of the same retirements. The shared messages name
 * classic tools the code prompt never mentions, so the code loop carries its
 * own vocabulary for the same rule: a spent allowance retires its own
 * capability, never the whole run.
 */
export const CODE_SEARCH_RETIRED_MESSAGE = 'Search allowance for this job is spent. Continue reading what you found with extract and read_source; do not ask for more searches.';

export const CODE_FETCH_RETIRED_MESSAGE = 'Page-read allowance for this job is spent. Further searches return snippets only; answer when the evidence suffices.';

/** What an early answer is missing. Null when the floor is met. */
export interface EvidenceFloorDeficit {
  missingSearches: number;
  missingFetches: number;
  pendingItems: number;
}

/**
 * Mechanical answer floor: searches run, pages read, plus a closed plan. The
 * model keeps the semantic judgment; the engine owns this minimum, so a run
 * cannot stop on snippets alone or with work still declared open.
 * Bypassed once a ceiling forces the answer — a floor must never stall a run
 * whose budget is spent.
 */
export function evidenceFloorDeficit(
  state: BudgetState,
  preset: ResearchPreset,
  pendingItems: number,
): EvidenceFloorDeficit | null {
  const missingSearches = Math.max(0, preset.minSearchCalls - state.usedSearchCalls);
  const missingFetches = Math.max(0, preset.minFetchCalls - state.usedFetchCalls);
  const openItems = Math.max(0, pendingItems);
  if (missingSearches === 0 && missingFetches === 0 && openItems === 0) return null;
  return { missingSearches, missingFetches, pendingItems: openItems };
}

/**
 * The rare floor-side injection, mirroring the ceiling-side wrap-up: sent once
 * per violation, never per round, so the cache prefix stays append-only in
 * healthy runs.
 */
export function evidenceFloorMessage(preset: ResearchPreset, deficit: EvidenceFloorDeficit): string {
  const parts: string[] = [];
  if (deficit.missingSearches > 0) {
    parts.push(`${deficit.missingSearches} more search(es) with \`web_search\` (minimum ${preset.minSearchCalls} for ${preset.mode} mode)`);
  }
  if (deficit.missingFetches > 0) {
    parts.push(`${deficit.missingFetches} more page(s) with \`fetch_url\` (minimum ${preset.minFetchCalls} for ${preset.mode} mode)`);
  }
  if (deficit.pendingItems > 0) {
    parts.push(`close the ${deficit.pendingItems} still-open plan item(s) with \`edit_plan\`, pointing each done item at its sources`);
  }
  return `[evidence-floor] Not enough evidence yet for ${preset.mode} mode: ${parts.join('; ')}. Do that work first, then answer from what you read.`;
}

/**
 * Records provider-reported usage under its model. Only calls the provider
 * actually reported are recorded; unpriced or unknown models still appear in the
 * ledger so a pricing gap is visible instead of silently free.
 */
export function recordTokenUsage(
  state: BudgetState,
  usage: {
    providerId: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    purpose?: string;
  },
): void {
  const key = usage.purpose ? `${usage.providerId}/${usage.modelId}#${usage.purpose}` : `${usage.providerId}/${usage.modelId}`;
  const existing = state.tokenLedger[key];
  if (existing) {
    existing.inputTokens += usage.inputTokens;
    existing.outputTokens += usage.outputTokens;
    existing.cacheReadTokens += usage.cacheReadTokens;
    existing.cacheWriteTokens += usage.cacheWriteTokens;
    existing.requests += 1;
    return;
  }
  state.tokenLedger[key] = { ...usage, requests: 1 };
}

export interface BudgetSnapshot {
  used_search_calls: number;
  search_calls_limit: number;
  used_fetch_calls: number;
  fetch_calls_limit: number;
  /** Sandbox execution seconds used (code engine only, else zero). */
  used_cpu_seconds: number;
  /** Billable tokens charged against `token_limit`, cache reads excluded. */
  used_tokens: number;
  token_limit: number;
  /**
   * Total tokens the provider reported, cache reads included. This is what the
   * provider was actually asked to process; `used_tokens` is what the job is
   * charged for. A consumer showing cost wants this one, not `used_tokens`.
   */
  used_total_tokens: number;
  elapsed_ms: number;
  wall_clock_limit_ms: number;
  used_steps: number;
  step_limit: number;
  exhausted_by: StopReason | null;
  /**
   * Per-model usage carried out of the run so billing can price each model at
   * its own rate. Present so a consumer can bill; consumers that only show
   * progress may ignore it.
   */
  token_ledger: Record<string, TokenUsageByModel>;
}

/**
 * Compact budget reading for the `read_budget` tool result. Used and limit
 * side by side so the model can size its next batch without arithmetic; the
 * remaining fields state what is left explicitly.
 */
/** The reading as data. The classic tool serialises it; the sandbox returns it
 *  structured so programs can compute over it without parsing. */
export function budgetReadingObject(state: BudgetState, preset: ResearchPreset, now: number = Date.now()): Record<string, number | string | null> {
  return {
    used_search_calls: state.usedSearchCalls,
    search_calls_limit: preset.maxSearchCalls,
    search_calls_remaining: remainingSearchCalls(state, preset),
    used_fetch_calls: state.usedFetchCalls,
    fetch_calls_limit: preset.maxFetchCalls,
    fetch_calls_remaining: remainingFetchCalls(state, preset),
    used_steps: state.usedSteps,
    step_limit: preset.maxSteps,
    used_billable_tokens: state.usedTokens,
    billable_token_limit: preset.maxBillableTokens,
    elapsed_ms: elapsedMs(state, now),
    wall_clock_limit_ms: preset.maxWallClockMs,
    exhausted_by: state.exhaustedBy,
  };
}

export function budgetReadingForModel(state: BudgetState, preset: ResearchPreset, now: number = Date.now()): string {
  return JSON.stringify(budgetReadingObject(state, preset, now));
}

export function budgetSnapshot(state: BudgetState, preset: ResearchPreset, now: number = Date.now()): BudgetSnapshot {
  return {
    used_search_calls: state.usedSearchCalls,
    search_calls_limit: preset.maxSearchCalls,
    used_fetch_calls: state.usedFetchCalls,
    fetch_calls_limit: preset.maxFetchCalls,
    used_cpu_seconds: state.usedCpuMs / 1000,
    used_tokens: state.usedTokens,
    token_limit: preset.maxBillableTokens,
    used_total_tokens: state.usedTotalTokens,
    elapsed_ms: elapsedMs(state, now),
    wall_clock_limit_ms: preset.maxWallClockMs,
    used_steps: state.usedSteps,
    step_limit: preset.maxSteps,
    exhausted_by: state.exhaustedBy,
    token_ledger: state.tokenLedger,
  };
}

/**
 * Research behaviour instructions for the active budget profile. The wording is
 * the model's steering surface, so it lives next to the ceilings it enforces
 * rather than in a prompt file that can drift from them.
 */
/**
 * A research mode sets effort, never confidence. Every mode shares the same floor: two
 * independent sources for a key claim, three when the claim is contested or
 * high-stakes, and an explicit unverified marker if the run ends early. A mode may only ever raise effort, never lower these requirements.
 */
export function modeBehaviorBlock(
  preset: ResearchPreset,
  pageReader: 'fetch_url' | 'extract' = 'fetch_url',
  planningEnabled = true,
): string {
  const deepRequirements = `
${planningEnabled ? '- Establish a coverage map of the requested parts and the members of any requested collection. Expand it when evidence reveals a material dependency or missing member.\n' : ''}
- Prioritise primary and authoritative sources (official documentation, institutional publications, direct records, legal texts). When a snippet points to one, \`${pageReader}\` it and read the content rather than relying on the snippet.
- Cover each evidence need across at least ${preset.minIndependentSources} independent source categories. Trace repeated reports to their origin; reports repeating the same record count as one line of evidence.
- **Never accept a figure, fact, or claim that rests only on search snippets.** Every key claim must trace to content you actually fetched and read. For an origin, an attribution, or a date, fetch the record itself — the episode, transcript, filing, or page that is the subject — and when it cannot be read, say the claim rests on reports about it.
- Resolve each contradiction before finalising. If two authoritative sources disagree, search further to determine which is correct and why.
- Test the strongest plausible alternative explanation for the answer-determining claims and follow the source trail when the available support is indirect.
- For anything you cannot confirm on the first approach, try a different source category, another language, or an archived version.
- Before answering, review gaps: list every open question, unverified claim, and unresolved contradiction, then close each one or state explicitly why it could not be closed. Ask what a skeptic would still dispute about your answer, and check that.`;
  const blocks: Record<ResearchMode, string> = {
    instant: `
**Research mode: INSTANT — Quick and accurate**
The ceilings bound the cost, so be efficient with calls without trading coverage for speed.
- Search each evidence need with different phrasings across different source categories, and read the sources that settle the answer; follow up on material uncertainty.
- Cover the topic from at least two distinct source categories. An official page and independent reporting count as two; two pages of the same kind count as one. One source type is never sufficient.
- Cross-check key claims against ${preset.minIndependentSources} independent sources.
- **Fetch the page when a number or wording matters.** For any figure, date, or claim the answer depends on, \`${pageReader}\` the primary source to confirm the exact value. A snippet does not verify such a claim.
- For values that genuinely vary by region, institution, or individual, report the verified range and say why the exact figures differ.
- An evidence need is "resolved" once its claims are corroborated including at least one fetched primary source and no contradiction is open. Stop when all needs meet this, or when a wrap-up signal appears.`,

    default: `
**Research mode: DEFAULT — Well corroborated**
The ceilings bound the cost, so use the calls the evidence needs: thoroughness here is the point.
- Work through every requested part, keeping its claims, supporting sources and unresolved qualifications together.
- Search each evidence need with different phrasings AND different source categories (official or government, independent news, academic, community forums, expert commentary). A single category is not acceptable.
- Cross-check key claims against ${preset.minIndependentSources} independent sources from different categories.
- **A snippet never verifies a key claim.** \`${pageReader}\` the primary source for every figure, date, and claim the answer states, and cite what you read rather than what the snippet suggested.
- Look for contradictions between sources and investigate them rather than averaging or ignoring the discrepancy.
- Check that sources are current; if a figure changed recently, find the most recent authoritative statement.
- An evidence need is "resolved" once its key claims trace to pages you fetched and read, including at least one primary source, and no contradiction is open. Stop when every requested part meets this, or when a wrap-up signal appears.`,

    deep: `
**Research mode: DEEP — Authoritative and cross-checked**
Aim for claims that trace back to authoritative sources and leave no contradiction open.
${deepRequirements}
- Stop after ${planningEnabled ? 'reviewing the coverage map' : 'checking the sources'} against the original request, when every need has sourced coverage or an explicit gap and no contradiction remains open — or when a wrap-up signal appears.`,

    max: `
**Research mode: MAX — Broad and scrutinised**
Search widely and scrutinise the sources themselves, including the ones that agree with you.
${deepRequirements}
${planningEnabled ? '- Set the inclusion criteria and build an inventory of relevant entities, cases, time periods or jurisdictions. Investigate missing members before declaring that inventory covered.\n' : ''}
- Actively seek out ALL relevant reliable sources. Do not stop at the first confirming set of results. Search across source categories, languages, time periods, and jurisdictions where relevant.
- Scrutinise the source: author credibility, publication authority, date, and whether it has been challenged elsewhere. Prefer primary over secondary and institutional over individual.
- Corroborate every key claim with ${preset.minIndependentSources} independent authoritative primary sources you actually read with \`${pageReader}\`, not merely found in snippets.
- Actively look for contradicting and minority views and evaluate them. Address credible ones in your answer; explain why the others are discounted.
- Stop after ${planningEnabled ? 'reviewing the inventory and the evidence' : 'reviewing the evidence'} against the original request, when every critical claim is corroborated from fetched primary sources and every contradiction is resolved or explicitly reported — or when a wrap-up signal appears.`,
  };
  /* The floor travels with the mode so the model plans to meet it instead of
     discovering it from a bounce. One home: the engine reads the same numbers
     when it gates an early answer. */
  const floorLine = `\n- Answer floor: run at least ${preset.minSearchCalls} searches and read at least ${preset.minFetchCalls} pages with \`${pageReader}\` before answering. An earlier answer is bounced back to gather the missing evidence.`;
  return `\n\n${blocks[preset.mode]}${floorLine}`;
}
