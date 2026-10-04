import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_RESEARCH_MODE,
  DEFAULT_RESEARCH_VERBOSITY,
  DEFAULT_RESPONSE_LENGTH,
  RESPONSE_LENGTHS,
  REASONING_EFFORT_BY_MODE,
  RESEARCH_MODES,
  RESEARCH_VERBOSITIES,
  assertResearchMode,
  budgetSnapshot,
  checkCeilings,
  chargeCpuMs,
  chargeFetchCalls,
  chargeSearchCalls,
  chargeTokens,
  chargeTotalTokens,
  createBudgetState,
  elapsedMs,
  modeBehaviorBlock,
  reasoningEffortForMode,
  remainingFetchCalls,
  remainingSearchCalls,
  resolveResearchPreset,
  type BudgetState,
} from '../src/engine/modes.js';
import { setConfig, resetConfigForTests, getConfig } from '../src/config/load.js';

describe('research contract', () => {
  it('exposes exactly four modes, cheapest first', () => {
    expect([...RESEARCH_MODES]).toEqual(['instant', 'default', 'deep', 'max']);
  });

  it('defaults to the default mode', () => {
    expect(DEFAULT_RESEARCH_MODE).toBe('default');
  });

  it('keeps verbosity about what the caller sees, and defaults to detailed', () => {
    /* `max` used to be a third verbosity. It did the same thing as detailed once
       answer length moved to response_length, so it is gone rather than kept. */
    expect([...RESEARCH_VERBOSITIES]).toEqual(['summary', 'detailed']);
    expect(DEFAULT_RESEARCH_VERBOSITY).toBe('detailed');
  });

  it('separates answer length from verbosity and defaults to long', () => {
    expect([...RESPONSE_LENGTHS]).toEqual(['short', 'long', 'exhaustive']);
    expect(DEFAULT_RESPONSE_LENGTH).toBe('long');
  });

  it('rejects an unknown mode instead of falling back to another one', () => {
    expect(() => assertResearchMode('deep-max')).toThrow(/Unknown research mode/);
    expect(() => assertResearchMode(undefined)).toThrow(/Unknown research mode/);
    expect(() => assertResearchMode('standard')).toThrow(/Unknown research mode/);
  });

  it('derives reasoning effort from the mode', () => {
    expect(reasoningEffortForMode('instant')).toBe('none');
    expect(reasoningEffortForMode('default')).toBe('low');
    expect(reasoningEffortForMode('deep')).toBe('medium');
    expect(reasoningEffortForMode('max')).toBe('xhigh');
  });

  it('has an effort for every mode', () => {
    for (const mode of RESEARCH_MODES) {
      expect(REASONING_EFFORT_BY_MODE[mode]).toBe(reasoningEffortForMode(mode));
    }
  });

  it('resolves each mode to its own configured ceilings', () => {
    for (const mode of RESEARCH_MODES) {
      const preset = resolveResearchPreset(mode);
      expect(preset.mode).toBe(mode);
      expect(preset.maxSearchCalls).toBe(getConfig().modes[mode].maxSearchCalls);
    }
  });

  it('carries no audit flag, because the claim audit was removed', () => {
    /* `max` used to set `auditAnswer`, which graded every claim against 400
       characters of snippet and deleted the ones it could not confirm. The
       property is gone rather than left set to false, so nothing can revive it
       by reading the mode. */
    for (const mode of ['instant', 'default', 'deep', 'max'] as const) {
      expect(resolveResearchPreset(mode)).not.toHaveProperty('auditAnswer');
    }
  });
});

describe('budget ceilings', () => {
  const preset = () => resolveResearchPreset('default');
  let state: BudgetState;

  beforeEach(() => {
    resetConfigForTests();
    state = createBudgetState(1_000);
  });

  afterEach(() => resetConfigForTests());

  it('starts with nothing consumed', () => {
    expect(state.usedSearchCalls).toBe(0);
    expect(state.usedFetchCalls).toBe(0);
    expect(state.usedTokens).toBe(0);
    expect(state.exhaustedBy).toBeNull();
  });

  it('charges searches and fetches against separate ceilings', () => {
    chargeSearchCalls(state, 2);
    chargeFetchCalls(state, 3);
    expect(state.usedSearchCalls).toBe(2);
    expect(state.usedFetchCalls).toBe(3);
    expect(remainingSearchCalls(state, preset())).toBe(preset().maxSearchCalls - 2);
    expect(remainingFetchCalls(state, preset())).toBe(preset().maxFetchCalls - 3);
  });

  it('reports the search_calls ceiling when searches run out', () => {
    chargeSearchCalls(state, preset().maxSearchCalls);
    expect(checkCeilings(state, preset(), 1_000)).toBe('search_calls');
  });

  it('reports the fetch_calls ceiling when page reads run out', () => {
    chargeFetchCalls(state, preset().maxFetchCalls);
    expect(checkCeilings(state, preset(), 1_000)).toBe('fetch_calls');
  });

  it('reports the tokens ceiling when the token budget is spent', () => {
    chargeTokens(state, preset().maxBillableTokens);
    expect(checkCeilings(state, preset(), 1_000)).toBe('tokens');
  });

  it('does not charge cache reads against the ceiling', () => {
    /* Cache reads are a re-read of a prefix the provider already holds, so they
       must not stop a long run. `chargeTotalTokens` is the cost view. */
    const cacheOnly = preset().maxBillableTokens;
    chargeTotalTokens(state, cacheOnly * 2);
    expect(state.usedTotalTokens).toBe(cacheOnly * 2);
    expect(state.usedTokens).toBe(0);
    expect(checkCeilings(state, preset(), 1_000)).toBeNull();
  });

  it('charges the billable amount once and counts the raw total separately', () => {
    chargeTokens(state, 1_000);
    chargeTotalTokens(state, 9_000);
    const snapshot = budgetSnapshot(state, preset(), 1_000);
    expect(snapshot.used_tokens).toBe(1_000);
    expect(snapshot.used_total_tokens).toBe(9_000);
    expect(snapshot.token_limit).toBe(preset().maxBillableTokens);
  });

  it('reports the wall_clock ceiling before the others once time passes', () => {
    chargeSearchCalls(state, preset().maxSearchCalls);
    expect(checkCeilings(state, preset(), 1_000 + preset().maxWallClockMs)).toBe('wall_clock');
  });

  it('reports the steps ceiling when rounds run out', () => {
    state.usedSteps = preset().maxSteps;
    expect(checkCeilings(state, preset(), 1_000)).toBe('steps');
  });

  it('returns null while the job may continue', () => {
    chargeSearchCalls(state, 1);
    chargeFetchCalls(state, 1);
    expect(checkCeilings(state, preset(), 1_000)).toBeNull();
  });

  it('measures elapsed time from the recorded start', () => {
    expect(elapsedMs(state, 1_500)).toBe(500);
  });
});

describe('budget snapshot', () => {
  it('reports every limit alongside its usage', () => {
    const preset = resolveResearchPreset('deep');
    const state = createBudgetState(0);
    chargeSearchCalls(state, 4);
    chargeFetchCalls(state, 2);
    const snapshot = budgetSnapshot(state, preset, 12_000);
    expect(snapshot).toMatchObject({
      used_search_calls: 4,
      search_calls_limit: preset.maxSearchCalls,
      used_fetch_calls: 2,
      fetch_calls_limit: preset.maxFetchCalls,
      elapsed_ms: 12_000,
      wall_clock_limit_ms: preset.maxWallClockMs,
      exhausted_by: null,
    });
  });
});

describe('mode behavior block', () => {
  it('names the active mode and its independent-source requirement', () => {
    const preset = resolveResearchPreset('max');
    const block = modeBehaviorBlock(preset);
    expect(block).toContain('MAX');
    expect(block).toContain(String(preset.minIndependentSources));
    /* The behavior block carries no notebook cadence line. The notebook is
       gone, and a mode block naming a tool that does not exist would send the
       model calling into an error message. */
    expect(block).not.toContain('write_notebook');
  });

  it('tracks sandbox execution time separately from tokens', () => {
    const state = createBudgetState(0);
    expect(state.usedCpuMs).toBe(0);
    chargeCpuMs(state, 1_500);
    chargeCpuMs(state, -200);
    expect(state.usedCpuMs).toBe(1_500);
    const snapshot = budgetSnapshot(state, resolveResearchPreset('instant'), 0);
    expect(snapshot.used_cpu_seconds).toBe(1.5);
  });

  it('produces a distinct block per mode', () => {
    const blocks = RESEARCH_MODES.map((mode) => modeBehaviorBlock(resolveResearchPreset(mode)));
    expect(new Set(blocks).size).toBe(RESEARCH_MODES.length);
  });

  it('raises the fetch and search floors with the mode; trivial inputs exit via decline', () => {
    /* Floors are set high on purpose. A request with nothing to research does
       not starve below them: it ends as declined through decline_request. */
    const fetchFloors = RESEARCH_MODES.map((mode) => resolveResearchPreset(mode).minFetchCalls);
    expect(fetchFloors).toEqual([10, 15, 30, 80]);
    const searchFloors = RESEARCH_MODES.map((mode) => resolveResearchPreset(mode).minSearchCalls);
    expect(searchFloors).toEqual([4, 8, 20, 50]);
  });
});


describe('configuration override', () => {
  afterEach(() => resetConfigForTests());

  it('uses configured ceilings instead of the shipped defaults', () => {
    const base = getConfig();
    setConfig({
      ...base,
      modes: {
        ...base.modes,
        instant: { ...base.modes.instant, maxSearchCalls: 1 },
      },
    });
    const preset = resolveResearchPreset('instant');
    expect(preset.maxSearchCalls).toBe(1);
    const state = createBudgetState(0);
    chargeSearchCalls(state, 1);
    expect(checkCeilings(state, preset, 0)).toBe('search_calls');
  });
});
