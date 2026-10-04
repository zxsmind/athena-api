import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config/defaults.js';
import { resetConfigForTests, setConfig } from '../src/config/load.js';
import { resolveResearchPreset } from '../src/engine/modes.js';

interface LLMCall {
  label?: string;
  tools?: { function?: { name?: string } }[];
  messages: { role: string; content?: string | null; tool_call_id?: string; tool_calls?: { id?: string; function: { name: string } }[] }[];
}

const llmCalls: LLMCall[] = [];
let script: Array<{ content?: string; tool_calls?: unknown[] }> = [];

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

let jobId = '';

beforeEach(() => {
  llmCalls.length = 0;
  script = [];
  jobId = `j-plan-test-${Date.now()}`;
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

function userMessages(): string[] {
  return llmCalls.flatMap((call) => call.messages
    .filter((message) => message.role === 'user' && message.content)
    .map((message) => message.content as string));
}

/**
 * The plan is a work record, not a decoration. The engine refuses a plan
 * written before any research, refuses done items without seen sources, and
 * bounces an early answer below the mode's floor — each with a message naming
 * what is missing, so the model fixes it in one retry.
 */
describe('plan enforcement in the engine', () => {
  it('rejects a turn-zero plan while the batched search still runs', async () => {
    script = [
      { tool_calls: [
        { id: 'plan_1', function: { name: 'create_plan', arguments: JSON.stringify({ goal: 'g', items: [{ text: 'Check records' }] }) } },
        { id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } },
      ] },
      { content: 'Answer' },
    ];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0, maxSteps: 10 };

    await agenticResearchStream('question', undefined, () => undefined, 'instant', { jobId, preset });

    expect(toolMessageFor('plan_1')).toMatch(/Plan rejected/);
    /* The search in the same batch ran and charged: reconnaissance happened. */
    const done = llmCalls.length;
    expect(done).toBeGreaterThanOrEqual(2);
  });

  it('rejects a bulk done without evidence and accepts it with seen sources', async () => {
    script = [
      { tool_calls: [{ id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } }] },
      { tool_calls: [{ id: 'plan_1', function: { name: 'create_plan', arguments: JSON.stringify({ goal: 'g', items: [{ text: 'Check records' }] }) } }] },
      { tool_calls: [{ id: 'edit_1', function: { name: 'edit_plan', arguments: JSON.stringify({ items: [{ text: 'Check records', status: 'done' }] }) } }] },
      { tool_calls: [{ id: 'edit_2', function: { name: 'edit_plan', arguments: JSON.stringify({ items: [{ text: 'Check records', status: 'done', evidence: [1] }] }) } }] },
      { content: 'Answer' },
    ];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0, maxSteps: 10 };

    await agenticResearchStream('question', undefined, () => undefined, 'instant', { jobId, preset });

    expect(toolMessageFor('edit_1')).toMatch(/without evidence/);
    expect(JSON.parse(toolMessageFor('edit_2') ?? '{}').ok).toBe(true);
  });

  it('bounces an early answer below the fetch floor, then takes the earned one', async () => {
    script = [
      { content: 'Early answer' },
      { tool_calls: [
        { id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } },
        { id: 'fetch_1', function: { name: 'fetch_url', arguments: JSON.stringify({ urls: ['https://example.com/a', 'https://example.com/b'] }) } },
      ] },
      { content: 'Earned answer' },
    ];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 2, minSearchCalls: 1, maxSteps: 10 };
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', { jobId, preset });

    expect(llmCalls.length).toBe(3);
    expect(userMessages().some((content) => content.includes('[evidence-floor]'))).toBe(true);
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Earned answer');
  });

  it('bounces an answer with plan items still open', async () => {
    script = [
      { tool_calls: [{ id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } }] },
      { tool_calls: [{ id: 'plan_1', function: { name: 'create_plan', arguments: JSON.stringify({ goal: 'g', items: [{ text: 'Check records' }] }) } }] },
      { content: 'Early answer' },
      { tool_calls: [{ id: 'edit_1', function: { name: 'edit_plan', arguments: JSON.stringify({ items: [{ text: 'Check records', status: 'done', evidence: [1] }] }) } }] },
      { content: 'Closed answer' },
    ];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 1, maxSteps: 10 };
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', { jobId, preset });

    expect(userMessages().some((content) => content.includes('[evidence-floor]'))).toBe(true);
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Closed answer');
  });

  it('retires only the spent tool: searches out, fetches continue', async () => {
    /* One search allowed. After it, web_search leaves the offered list while
       fetch_url stays, and the run answers from what it read. */
    script = [
      { tool_calls: [{ id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } }] },
      { tool_calls: [{ id: 'fetch_1', function: { name: 'fetch_url', arguments: JSON.stringify({ urls: ['https://example.com/a'] }) } }] },
      { content: 'Read answer' },
    ];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0, maxSteps: 10, maxSearchCalls: 1, maxFetchCalls: 4 };
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', { jobId, preset });

    const secondTools = llmCalls[1].tools?.map((tool) => tool.function?.name) ?? [];
    expect(secondTools).toContain('fetch_url');
    expect(secondTools).not.toContain('web_search');
    const seen = llmCalls.flatMap((call) => call.messages
      .filter((message) => message.role === 'user' && message.content)
      .map((message) => message.content as string));
    expect(seen.some((content) => content.includes('Search allowance for this job is spent'))).toBe(true);
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Read answer');
  });

  it('answers a stale call to a retired tool instead of dropping its result', async () => {
    script = [
      { tool_calls: [{ id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } }] },
      { tool_calls: [
        { id: 'search_2', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['beta'] }) } },
        { id: 'fetch_1', function: { name: 'fetch_url', arguments: JSON.stringify({ urls: ['https://example.com/a'] }) } },
      ] },
      { content: 'Read answer' },
    ];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0, maxSteps: 10, maxSearchCalls: 1, maxFetchCalls: 4 };
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', { jobId, preset });

    const spent = llmCalls.flatMap((call) => call.messages
      .filter((message) => message.tool_call_id === 'search_2')
      .map((message) => message.content as string));
    expect(spent.some((content) => content.includes('Search allowance for this job is spent'))).toBe(true);
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Read answer');
  });

  it('never bounces once a ceiling has forced the answer', async () => {
    /* Zero search calls allowed, so the ceiling fires before the model acts
       and the first answer is taken despite the unmet floor. */
    script = [{ content: 'Early answer' }];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 2, maxSteps: 1, maxSearchCalls: 0, maxFetchCalls: 0 };
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', { jobId, preset });

    const seen = llmCalls.flatMap((call) => call.messages
      .filter((message) => message.role === 'user' && message.content)
      .map((message) => message.content as string));
    expect(seen.some((content) => content.includes('[evidence-floor]'))).toBe(false);
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Early answer');
  });
});
