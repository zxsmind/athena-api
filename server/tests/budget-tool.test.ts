import { describe, expect, it } from 'vitest';
import { READ_BUDGET_TOOL, READ_BUDGET_TOOL_NAME } from '../src/engine/types.js';
import {
  budgetReadingForModel,
  chargeFetchCalls,
  chargeSearchCalls,
  createBudgetState,
  resolveResearchPreset,
} from '../src/engine/modes.js';

describe('read_budget tool', () => {
  it('takes no parameters and spends no budget itself', () => {
    expect(READ_BUDGET_TOOL_NAME).toBe('read_budget');
    expect(READ_BUDGET_TOOL.function.name).toBe('read_budget');
    expect(READ_BUDGET_TOOL.function.parameters.properties).toEqual({});
    /* The schema states the batching contract, because the system prompt is
       not read at call time and the bare tool gives no reason to batch. */
    expect(READ_BUDGET_TOOL.function.description).toMatch(/same response/);
    expect(READ_BUDGET_TOOL.function.description).toMatch(/spends no budget/);
  });

  it('reports used, limit, and remaining side by side', () => {
    const preset = resolveResearchPreset('instant');
    const state = createBudgetState(1_000);
    chargeSearchCalls(state, 6);
    chargeFetchCalls(state, 4);
    const reading = JSON.parse(budgetReadingForModel(state, preset, 2_000));
    expect(reading).toMatchObject({
      used_search_calls: 6,
      search_calls_limit: preset.maxSearchCalls,
      search_calls_remaining: preset.maxSearchCalls - 6,
      used_fetch_calls: 4,
      fetch_calls_limit: preset.maxFetchCalls,
      fetch_calls_remaining: preset.maxFetchCalls - 4,
      used_steps: 0,
      step_limit: preset.maxSteps,
      exhausted_by: null,
    });
    expect(reading.elapsed_ms).toBe(1_000);
  });
});
