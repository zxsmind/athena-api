import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config/defaults.js';
import { resetConfigForTests, setConfig } from '../src/config/load.js';
import { DECLINE_REQUEST_TOOL, DECLINE_REQUEST_TOOL_NAME } from '../src/engine/types.js';
import { resolveResearchPreset } from '../src/engine/modes.js';
import type { BudgetState } from '../src/engine/modes.js';

interface LLMCall {
  label?: string;
  tools?: { function?: { name?: string } }[];
  messages: { role: string; content?: string | null; tool_call_id?: string; tool_calls?: { id?: string; function: { name: string } }[] }[];
}

const llmCalls: LLMCall[] = [];
let script: Array<{ content?: string; tool_calls?: unknown[] }> = [];
const budgetStates: BudgetState[] = [];

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    callLLMStream: vi.fn(async (options: LLMCall) => {
    /* Live messages reference, not a clone: a terminal decline ends the run
       in its first round, so a snapshot at call time would never show the
       tool results pushed afterwards. */
    llmCalls.push({ ...options, messages: options.messages });
    const step = script.shift() ?? { content: 'fallback answer' };
    return {
      data: { choices: [{ message: { role: 'assistant', content: step.content ?? null, tool_calls: step.tool_calls } }] },
      model: 'mock-model',
      provider: 'mock-provider',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, requests: 1, reported: true },
    };
  }),
  stripThinkingTags: (text: string) => text,
  };
});

vi.mock('../src/search/index.js', () => ({
  searchResults: vi.fn(async () => ({
    results: [{ title: 'Example', url: 'https://example.com', snippet: 'snip' }],
    queryText: 'x',
    provider: 'mock',
  })),
  extractPageContent: vi.fn(async () => ({ title: 'Page', content: 'page text' })),
}));

import { agenticResearchStream, type EngineEvent } from '../src/engine.js';

let jobId = '';

beforeEach(() => {
  llmCalls.length = 0;
  budgetStates.length = 0;
  script = [];
  jobId = `j-decline-test-${Date.now()}`;
  setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: false } });
});

afterEach(() => {
  resetConfigForTests();
});

function toolMessageFor(callId: string): string | null {
  for (const call of llmCalls) {
    const found = call.messages.find((message) => message.tool_call_id === callId);
    if (found?.content) return found.content;
  }
  return null;
}

/**
 * decline_request ends non-questions without starving them below the fetch
 * floor. It wins terminally, spends nothing further, answers every call id in
 * the batch, and never advances the research counters.
 */
describe('decline_request in the engine', () => {
  it('requires a reason in the schema', () => {
    expect(DECLINE_REQUEST_TOOL_NAME).toBe('decline_request');
    expect(DECLINE_REQUEST_TOOL.function.name).toBe('decline_request');
    expect(DECLINE_REQUEST_TOOL.function.parameters.required).toEqual(['reason']);
    expect(DECLINE_REQUEST_TOOL.function.description).toMatch(/only when the input is not a research question/);
  });

  it('is offered alongside the research tools', async () => {
    script = [{ content: 'Answer [1]' }];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0 };

    await agenticResearchStream('question', undefined, () => undefined, 'instant', { jobId, preset });

    const names = llmCalls[0].tools?.map((tool) => tool.function?.name) ?? [];
    expect(names).toContain('decline_request');
  });

  it('ends the run on a lone decline without charging research', async () => {
    const events: EngineEvent[] = [];
    script = [
      { tool_calls: [{ id: 'decline_1', function: { name: 'decline_request', arguments: JSON.stringify({ reason: 'Just a greeting.' }) } }] },
    ];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', {
      jobId,
      preset: { ...resolveResearchPreset('instant'), minFetchCalls: 10, maxSteps: 10 },
      onProgress: (state) => { budgetStates.push(state.budgetState); },
    });

    expect(toolMessageFor('decline_1')).toMatch(/Just a greeting/);
    /* Below the floor, yet taken: decline is an exit, not an answer. One
       round total, so nothing could charge after it. */
    const declined = events.find((event) => event.type === 'declined');
    expect(declined).toMatchObject({ type: 'declined', reason: 'Just a greeting.' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(llmCalls.length).toBe(1);
  });

  it('drops same-batch research unexecuted and answers every call id', async () => {
    const events: EngineEvent[] = [];
    script = [
      { tool_calls: [
        { id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } },
        { id: 'decline_1', function: { name: 'decline_request', arguments: JSON.stringify({ reason: 'Nonsense input.' }) } },
      ] },
    ];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', {
      jobId,
      preset: { ...resolveResearchPreset('instant'), minFetchCalls: 10, maxSteps: 10 },
      onProgress: (state) => { budgetStates.push(state.budgetState); },
    });

    /* The batched search never ran: the run ended in its first round. */
    expect(llmCalls.length).toBe(1);
    expect(toolMessageFor('search_1')).toMatch(/declined/);
    expect(events.find((event) => event.type === 'declined')).toBeDefined();
  });

  it('defaults an empty reason instead of breaking the turn', async () => {
    const events: EngineEvent[] = [];
    script = [
      { tool_calls: [{ id: 'decline_1', function: { name: 'decline_request', arguments: JSON.stringify({}) } }] },
    ];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', {
      jobId,
      preset: { ...resolveResearchPreset('instant'), minFetchCalls: 10, maxSteps: 10 },
    });

    expect(toolMessageFor('decline_1')).toMatch(/Request declined/);
    expect(events.find((event) => event.type === 'declined')).toMatchObject({ reason: 'No reason given.' });
  });
});
