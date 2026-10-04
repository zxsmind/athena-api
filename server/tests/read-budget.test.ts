import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config/defaults.js';
import { resetConfigForTests, setConfig } from '../src/config/load.js';
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
    llmCalls.push({ ...options, messages: structuredClone(options.messages) });
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
import { resolveResearchPreset } from '../src/engine/modes.js';

let jobId = '';

beforeEach(() => {
  llmCalls.length = 0;
  budgetStates.length = 0;
  script = [];
  jobId = `j-budget-test-${Date.now()}`;
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
 * The budget is read on demand, never injected. A batch carrying read_budget
 * reports the remainder after that batch is charged, so the model sizes the
 * next batch from what is left rather than from the balance before it.
 */
describe('read_budget in the engine', () => {
  it('is offered alongside search, fetch, and progress', async () => {
    script = [{ content: 'Answer [1]' }];

    await agenticResearchStream('question', undefined, () => undefined, 'instant', {
      jobId,
      preset: { ...resolveResearchPreset('instant'), minFetchCalls: 0 },
    });

    const names = llmCalls[0].tools?.map((tool) => tool.function?.name) ?? [];
    expect(names).toContain('read_budget');
    expect(names).toContain('web_search');
    expect(names).toContain('fetch_url');
    expect(names).toContain('report_progress');
  });

  it('answers a batched read after the turn charges, without charging itself', async () => {
    script = [
      { tool_calls: [
        { id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } },
        { id: 'fetch_1', function: { name: 'fetch_url', arguments: JSON.stringify({ urls: ['https://example.com/a', 'https://example.com/b'] }) } },
        { id: 'budget_1', function: { name: 'read_budget', arguments: JSON.stringify({}) } },
      ] },
      { content: 'Answer [1]' },
    ];
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', {
      jobId,
      preset: { ...resolveResearchPreset('instant'), minFetchCalls: 2, minSearchCalls: 1 },
      onProgress: (state) => { budgetStates.push(state.budgetState); },
    });

    /* Post-turn: one search and two fetches already charged when answered. A
       pre-turn reading would report zeros here. */
    const reading = JSON.parse(toolMessageFor('budget_1') ?? '{}');
    expect(reading.used_search_calls).toBe(1);
    expect(reading.used_fetch_calls).toBe(2);
    expect(reading.search_calls_remaining).toBe(reading.search_calls_limit - 1);
    /* The read itself added no charge, and the floor is met, so the answer is
       taken instead of bounced. */
    const last = budgetStates[budgetStates.length - 1];
    expect(last.usedSearchCalls).toBe(1);
    expect(last.usedFetchCalls).toBe(2);
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Answer [1]');
  });

  it('answers a lone read without an error message', async () => {
    const events: EngineEvent[] = [];
    script = [
      { tool_calls: [{ id: 'budget_1', function: { name: 'read_budget', arguments: JSON.stringify({}) } }] },
      /* No sources exist, so no citation: the engine strips invented ones. */
      { content: 'Answer' },
    ];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', {
      jobId,
      preset: { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0 },
    });

    const reading = JSON.parse(toolMessageFor('budget_1') ?? '{}');
    expect(reading.used_search_calls).toBe(0);
    expect(reading.used_fetch_calls).toBe(0);
    expect(toolMessageFor('budget_1')).not.toMatch(/Invalid tool call/);
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Answer');
  });
});
