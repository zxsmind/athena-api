import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config/defaults.js';
import { resetConfigForTests, setConfig } from '../src/config/load.js';
import { resolveResearchPreset } from '../src/engine/modes.js';

interface LLMCall {
  label?: string;
  tools?: { function?: { name?: string } }[];
  messages: { role: string; content?: string | null; reasoning?: string | null; tool_calls?: { id?: string; function: { name: string } }[] }[];
}

interface ScriptStep {
  content?: string;
  tool_calls?: unknown[];
  reasoning?: string;
}

const llmCalls: LLMCall[] = [];
let script: ScriptStep[] = [];

vi.mock('../src/llm.js', () => ({
  callLLMStream: vi.fn(async (options: LLMCall) => {
    llmCalls.push({ ...options, messages: options.messages });
    const step = script.shift() ?? { content: 'fallback answer' };
    return {
      data: { choices: [{ message: { role: 'assistant', content: step.content ?? null, tool_calls: step.tool_calls, reasoning: step.reasoning ?? null } }] },
      model: 'mock-model',
      provider: 'mock-provider',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, requests: 1, reported: true },
    };
  }),
  stripThinkingTags: (text: string) => text,
  extractThinkBlockText: (text: string) => {
    const blocks = [...text.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/gi)];
    const kept = blocks.map((block) => block[1].trim()).filter((part) => part.length > 0);
    return kept.length > 0 ? kept.join('\n\n') : null;
  },
}));

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
  jobId = `j-reasoning-test-${Date.now()}`;
  setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: false } });
});

afterEach(() => {
  resetConfigForTests();
});

function assistantMessages(callIndex: number): LLMCall['messages'] {
  return llmCalls[callIndex].messages.filter((message) => message.role === 'assistant');
}

/**
 * Reasoning is never deleted: the deliberation a thinking model returns rides
 * along for the next round instead of being stripped for display and dropped.
 */
describe('reasoning preserved across rounds', () => {
  it('carries the reasoning field into the next round', async () => {
    script = [
      { tool_calls: [{ id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } }], reasoning: 'First survey the field, then dig into primaries.' },
      { content: 'Answer [1]' },
    ];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0, maxSteps: 10 };

    await agenticResearchStream('question', undefined, () => undefined, 'instant', { jobId, preset });

    const carried = assistantMessages(1).find((message) => message.reasoning === 'First survey the field, then dig into primaries.');
    expect(carried).toBeDefined();
  });

  it('rescues deliberation embedded in think tags', async () => {
    script = [
      { content: '<think>Check the primary source first.</think>Searching now.', tool_calls: [{ id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } }] },
      { content: 'Answer [1]' },
    ];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0, maxSteps: 10 };

    await agenticResearchStream('question', undefined, () => undefined, 'instant', { jobId, preset });

    const carried = assistantMessages(1)
      .map((message) => message.reasoning ?? '')
      .filter((reasoning) => reasoning.length > 0);
    expect(carried.some((reasoning) => reasoning.includes('Check the primary source first.'))).toBe(true);
  });

  it('still strips tags for display while keeping them for history', async () => {
    const events: EngineEvent[] = [];
    script = [
      { content: '<think>Hidden plan.</think>Visible note.', tool_calls: [{ id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha'] }) } }] },
      { content: 'Answer [1]' },
    ];
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0, maxSteps: 10 };

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', { jobId, preset });

    /* Step notes show the visible text; the history keeps the deliberation. */
    const history = assistantMessages(1);
    expect(history.some((message) => (message.reasoning ?? '').includes('Hidden plan.'))).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(true);
  });
});
