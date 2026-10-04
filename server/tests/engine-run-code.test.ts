import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config/defaults.js';
import { resetConfigForTests, setConfig } from '../src/config/load.js';
import { RESEARCH_MODES, modeBehaviorBlock, resolveResearchPreset, type BudgetState } from '../src/engine/modes.js';
import { closeAllSandboxes, setSandboxFactoryForTests } from '../src/sandbox/manager.js';
import type { SandboxHandlers } from '../src/sandbox/types.js';

interface LLMCall {
  label?: string;
  tools?: { function?: { name?: string } }[];
  messages: { role: string; content?: string | null; tool_call_id?: string; tool_calls?: { function: { name: string } }[] }[];
}

const llmCalls: LLMCall[] = [];
const systemAtCall: string[] = [];
let script: Array<{ content?: string; tool_calls?: unknown[] }> = [];

vi.mock('../src/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/llm.js')>();
  return {
    ...actual,
    callLLMStream: vi.fn(async (options: LLMCall) => {
    llmCalls.push({ ...options, messages: structuredClone(options.messages) });
    systemAtCall.push(String(options.messages[0]?.content ?? ''));
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
import { deleteEvidence } from '../src/engine/evidence-store.js';

let closed = false;
let handlers: SandboxHandlers | null = null;
let jobId = '';

beforeEach(() => {
  llmCalls.length = 0;
  systemAtCall.length = 0;
  script = [];
  closed = false;
  handlers = null;
  jobId = `j-sandbox-test-${Date.now()}`;
  setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: true } });
  setSandboxFactoryForTests((next) => {
    handlers = next;
    return {
      setHandlers: (updated) => {
        handlers = updated;
      },
      run: async () => {
        const found = (await handlers!.search({ queries: ['x'] })) as { results: { n: number }[] };
        const recalled = (await handlers!.read_source({ n: found.results[0].n })) as { content: string };
        return { ok: true, value: JSON.stringify({ found, recalled: recalled.content }), stdout: '' };
      },
      exportState: async () => null,
      hydrate: () => undefined,
      close: () => {
        closed = true;
      },
    };
  });
});

afterEach(() => {
  closeAllSandboxes();
  setSandboxFactoryForTests(null);
  resetConfigForTests();
  deleteEvidence(jobId);
});

describe('run_code in the engine', () => {
  it.each(RESEARCH_MODES)('sends the %s mode policy to the code engine using its own page reader', async (mode) => {
    script = [{ content: 'Answer' }];

    await agenticResearchStream('question', undefined, () => undefined, mode, { jobId });

    const system = systemAtCall[0];
    expect(system).toContain(modeBehaviorBlock(resolveResearchPreset(mode), 'extract'));
    expect(system).toContain(`Research mode: ${mode.toUpperCase()}`);
    expect(system).not.toMatch(/web_search|fetch_url|read_plan|report_progress|read_budget/);
  });

  it('counts research tool calls within a response without charging plan or progress calls', async () => {
    setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: false } });
    const preset = { ...resolveResearchPreset('default'), maxSteps: 10, wrapUpToolCalls: 2, forceAnswerToolCalls: 3 };
    script = [
      { tool_calls: [
        { id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha', 'beta'] }) } },
        { id: 'fetch_1', function: { name: 'fetch_url', arguments: JSON.stringify({ urls: ['https://example.com/a', 'https://example.com/b'] }) } },
        { id: 'plan_1', function: { name: 'create_plan', arguments: JSON.stringify({ goal: 'Compare records', items: [{ text: 'Check records' }] }) } },
        { id: 'progress_1', function: { name: 'report_progress', arguments: JSON.stringify({ headline: 'Checking records', body: 'Two records contain the relevant figures.' }) } },
      ] },
      { tool_calls: [{ id: 'search_2', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['gamma'] }) } }] },
      { content: 'Answer [1]' },
    ];

    await agenticResearchStream('question', undefined, () => undefined, 'default', { jobId, preset });

    expect(llmCalls[1].messages.some(message => message.content?.startsWith('[wrap-up]'))).toBe(true);
    expect(llmCalls[1].tools?.some(tool => tool.function?.name === 'web_search')).toBe(true);
    expect(llmCalls[2].tools).toBeUndefined();
  });

  it('keeps the page-read allowance independent of searches in the same response', async () => {
    setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: false } });
    const preset = { ...resolveResearchPreset('default'), maxFetchCalls: 2 };
    script = [
      { tool_calls: [
        { id: 'search_1', function: { name: 'web_search', arguments: JSON.stringify({ queries: ['alpha', 'beta'] }) } },
        { id: 'fetch_1', function: { name: 'fetch_url', arguments: JSON.stringify({ urls: ['https://example.com/a', 'https://example.com/b'] }) } },
      ] },
      { content: 'Answer [1]' },
    ];
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, event => events.push(event), 'default', { jobId, preset });

    const done = events.find(event => event.type === 'done') as { response?: { research_budget?: { used_search_calls: number; used_fetch_calls: number } } } | undefined;
    expect(done?.response?.research_budget).toMatchObject({ used_search_calls: 2, used_fetch_calls: 2 });
    const results = llmCalls[1].messages.filter(message => message.role === 'tool' && message.tool_call_id === 'fetch_1');
    expect(results).toHaveLength(2);
    expect(results.every(message => message.content?.includes('page text'))).toBe(true);
  });

  it.each([false, true])('warns before the last research step and still synthesizes at the ceiling (code=%s)', async (code) => {
    setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: code } });
    const preset = { ...resolveResearchPreset('default'), maxSteps: 3, wrapUpToolCalls: 20, forceAnswerToolCalls: 30 };
    const call = (number: number) => ({ tool_calls: [{
      id: `call_${number}`,
      function: code
        ? { name: 'run_code', arguments: JSON.stringify({ code: 'program', label: 'probe' }) }
        : { name: 'web_search', arguments: JSON.stringify({ queries: [`query ${number}`] }) },
    }] });
    script = [call(1), call(2), call(3), { content: 'Final answer [1]' }];
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, event => events.push(event), 'default', { jobId, preset });

    expect(llmCalls[1].messages.some(message => message.content?.startsWith('[wrap-up]'))).toBe(false);
    expect(llmCalls[2].messages.filter(message => message.content?.startsWith('[wrap-up]'))).toHaveLength(1);
    expect(llmCalls[2].tools?.length).toBeGreaterThan(0);
    expect(llmCalls[3].tools).toBeUndefined();
    const done = events.find(event => event.type === 'done') as { response?: { research_budget?: { exhausted_by?: string; used_cpu_seconds?: unknown } } } | undefined;
    expect(done?.response?.research_budget?.exhausted_by).toBe('steps');
    /* Both engines report execution seconds; classic runs stay at zero. */
    expect(typeof done?.response?.research_budget?.used_cpu_seconds).toBe('number');
  });

  it('uses the code mode force-answer threshold even when the step ceiling is farther away', async () => {
    const preset = { ...resolveResearchPreset('default'), maxSteps: 10, wrapUpToolCalls: 1, forceAnswerToolCalls: 2 };
    script = [
      { tool_calls: [
        { id: 'code_1', function: { name: 'run_code', arguments: JSON.stringify({ code: 'program', label: 'first' }) } },
        { id: 'code_2', function: { name: 'run_code', arguments: JSON.stringify({ code: 'program', label: 'second' }) } },
      ] },
      { content: 'Final answer [1]' },
    ];

    await agenticResearchStream('question', undefined, () => undefined, 'default', { jobId, preset });

    expect(llmCalls[1].tools).toBeUndefined();
    expect(llmCalls.map(call => call.label)).not.toContain('code-verify');
  });

  it('offers the tool, runs the program, and feeds the result back as the tool message', async () => {
    script = [
      { tool_calls: [{ id: 'call_1', function: { name: 'run_code', arguments: JSON.stringify({ code: 'program', label: 'probe' }) } }] },
      { content: 'Answer [1]' },
    ];
    const events: EngineEvent[] = [];
    /* Floor zeroed: this test is about tool plumbing, not the evidence floor. */
    const preset = { ...resolveResearchPreset('default'), minFetchCalls: 0, minSearchCalls: 0 };

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'default', { jobId, preset });

    expect(llmCalls[0].tools?.map((tool) => tool.function?.name)).toEqual(['run_code']);
    const toolMessages = (llmCalls[1].messages ?? []).filter((message) => message.role === 'tool');
    expect(toolMessages.length).toBe(1);
    expect(toolMessages[0].content).toContain('https://example.com');
    expect(toolMessages[0].content).toContain('snip');
    expect(toolMessages[0].content).toContain('[Source #1');

    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Answer [1]');
    expect(closed).toBe(true);
  });

  it('publishes budget progress so the runner can bill code runs', async () => {
    /* The code engine never called onProgress: no live budget, and billJob
       skipped for lack of runtime. One search through the mocked factory must
       surface in the published state, with execution time attached. */
    script = [
      { tool_calls: [{ id: 'call_1', function: { name: 'run_code', arguments: JSON.stringify({ code: 'program', label: 'probe' }) } }] },
      { content: 'Answer [1]' },
    ];
    const states: { round: number; budgetState: BudgetState }[] = [];
    await agenticResearchStream('question', undefined, () => undefined, 'default', {
      jobId,
      onProgress: (state) => { states.push({ round: state.round, budgetState: state.budgetState }); },
    });
    expect(states.length).toBeGreaterThan(0);
    const last = states[states.length - 1].budgetState;
    expect(last.usedSearchCalls).toBe(1);
    expect(last.usedCpuMs).toBeGreaterThanOrEqual(0);
  });

  it('ends the run declined when a program declines', async () => {
    setSandboxFactoryForTests((handlers) => ({
      setHandlers: () => undefined,
      run: async () => {
        await handlers.decline({ reason: 'Just a greeting.' });
        return { ok: true, value: '{}', stdout: '' };
      },
      exportState: async () => null,
      hydrate: () => undefined,
      close: () => undefined,
    }));
    script = [
      { tool_calls: [{ id: 'call_1', function: { name: 'run_code', arguments: JSON.stringify({ code: 'decline', label: 'probe' }) } }] },
    ];
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'default', { jobId });

    expect(events.find((event) => event.type === 'declined')).toMatchObject({ reason: 'Just a greeting.' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  });

  it('bounces a code answer below the floor and takes it once earned', async () => {
    setSandboxFactoryForTests((handlers) => ({
      setHandlers: () => undefined,
      run: async () => {
        await handlers.search({ queries: ['alpha'] });
        await handlers.extract({ urls: ['https://example.com/a'] });
        return { ok: true, value: '{}', stdout: '' };
      },
      exportState: async () => null,
      hydrate: () => undefined,
      close: () => undefined,
    }));
    /* One search and one fetch per program against a floor of two fetches:
       the early answer bounces, and the earned one passes after the second
       program. Sources resolve: the mocked search numbers example.com as 1. */
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 2, minSearchCalls: 1, maxSteps: 10 };
    script = [
      { tool_calls: [{ id: 'call_1', function: { name: 'run_code', arguments: JSON.stringify({ code: 'research', label: 'probe' }) } }] },
      { content: 'Early answer' },
      { tool_calls: [{ id: 'call_2', function: { name: 'run_code', arguments: JSON.stringify({ code: 'more', label: 'probe' }) } }] },
      { content: 'Earned answer [1]' },
    ];
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', { jobId, preset });

    /* Two programs and two answers; the verifier is gone, so no extra call. */
    expect(llmCalls.length).toBe(4);
    expect(llmCalls[2].messages.some((message) => message.content?.includes('[evidence-floor]'))).toBe(true);
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Earned answer [1]');
  });

  it('runs the sandbox plan flow with engine-verified closes', async () => {
    setSandboxFactoryForTests((handlers) => ({
      setHandlers: () => undefined,
      run: async () => {
        await handlers.search({ queries: ['alpha'] });
        await handlers.plan({ goal: 'g', items: [{ text: 'Check records' }] });
        await handlers.plan_update({ items: [{ text: 'Check records', status: 'done', evidence: [1] }] });
        return { ok: true, value: '{}', stdout: '' };
      },
      exportState: async () => null,
      hydrate: () => undefined,
      close: () => undefined,
    }));
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0, maxSteps: 10 };
    script = [
      { tool_calls: [{ id: 'call_1', function: { name: 'run_code', arguments: JSON.stringify({ code: 'research', label: 'probe' }) } }] },
      { content: 'Answer [1]' },
    ];
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', { jobId, preset });

    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Answer [1]');
  });

  it('retires searches without forcing the answer while fetches remain', async () => {
    /* One search allowed. After it, the run continues fetch-only instead of
       ending with the fetch allowance untouched. Custom factory: the shared
       one indexes results[0], which denial leaves empty. */
    let searched = false;
    setSandboxFactoryForTests((handlers) => ({
      setHandlers: () => undefined,
      run: async () => {
        if (!searched) {
          searched = true;
          await handlers.search({ queries: ['x'] });
        }
        return { ok: true, value: '{}', stdout: '' };
      },
      exportState: async () => null,
      hydrate: () => undefined,
      close: () => undefined,
    }));
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0, maxSteps: 10, maxSearchCalls: 1, maxFetchCalls: 4 };
    script = [
      { tool_calls: [{ id: 'call_1', function: { name: 'run_code', arguments: JSON.stringify({ code: 'search', label: 'probe' }) } }] },
      { tool_calls: [{ id: 'call_2', function: { name: 'run_code', arguments: JSON.stringify({ code: 'search again', label: 'probe' }) } }] },
      { content: 'Answer [1]' },
    ];
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', { jobId, preset });

    expect(llmCalls[1].messages.some((message) => message.content?.includes('Search allowance for this job is spent'))).toBe(true);
    expect(llmCalls[1].tools).toBeDefined();
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Answer [1]');
  });

  it('forces the answer only when both allowances are out', async () => {
    const preset = { ...resolveResearchPreset('instant'), minFetchCalls: 0, minSearchCalls: 0, maxSteps: 10, maxSearchCalls: 1, maxFetchCalls: 0 };
    script = [
      { tool_calls: [{ id: 'call_1', function: { name: 'run_code', arguments: JSON.stringify({ code: 'search', label: 'probe' }) } }] },
      { content: 'Answer [1]' },
    ];
    const events: EngineEvent[] = [];

    await agenticResearchStream('question', undefined, (event) => events.push(event), 'instant', { jobId, preset });

    const done = events.find((event) => event.type === 'done') as { response?: { research_budget?: { exhausted_by?: string } } } | undefined;
    expect(done?.response?.research_budget?.exhausted_by).toBe('search_calls');
  });

  it('selects the code engine when enabled and the classic engine when disabled', async () => {
    script = [{ content: 'no tools needed' }];
    await agenticResearchStream('question', undefined, () => undefined, 'default', { jobId });
    expect(llmCalls[0].tools?.map((tool) => tool.function?.name)).toEqual(['run_code']);
    expect(llmCalls[0].messages[0].content).toContain('Working in the sandbox');
    expect(llmCalls[0].messages[0].content).not.toContain('web_search');

    llmCalls.length = 0;
    script = [{ content: 'no tools needed' }];
    const classicJob = `${jobId}-b`;
    setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: false } });
    await agenticResearchStream('question', undefined, () => undefined, 'default', { jobId: classicJob });
    const classicTools = (llmCalls[0].tools ?? []).map((tool) => tool.function?.name);
    expect(classicTools).toContain('web_search');
    expect(classicTools).not.toContain('run_code');
    expect(llmCalls[0].messages[0].content).not.toContain('Working in the sandbox');
    deleteEvidence(classicJob);
  });

  it('omits plan tools and plan instructions when an experiment disables planning', async () => {
    setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: false } });
    script = [
      { tool_calls: [{ id: 'plan_1', function: { name: 'create_plan', arguments: JSON.stringify({ goal: 'Research the question', items: [{ text: 'Find evidence' }] }) } }] },
      { content: 'Answer from the retrieved evidence.' },
    ];
    const events: EngineEvent[] = [];

    await agenticResearchStream('Research question', undefined, event => events.push(event), 'deep', { jobId, planningEnabled: false });

    const firstTools = llmCalls[0].tools?.map(tool => tool.function?.name) ?? [];
    expect(firstTools).not.toContain('create_plan');
    expect(firstTools).not.toContain('edit_plan');
    expect(firstTools).not.toContain('read_plan');
    expect(systemAtCall[0]).not.toMatch(/\bplan\b|create_plan|edit_plan|read_plan/i);
    expect(systemAtCall[0]).not.toMatch(/coverage map|inclusion criteria and build an inventory/i);
    expect(llmCalls[1].messages.some(message => message.content?.includes('Planning tools are disabled'))).toBe(true);
    expect(events.some(event => event.type === 'step' && event.data.type === 'plan')).toBe(false);
  });

  it('keeps the first request cold, because a cached first turn came back without a tool call', async () => {
    script = [
      { tool_calls: [{ id: 'call_1', function: { name: 'run_code', arguments: JSON.stringify({ code: 'program', label: 'probe' }) } }] },
      { content: 'Answer [1]' },
    ];
    await agenticResearchStream('question', undefined, () => undefined, 'default', { jobId });

    const firstSystem = systemAtCall[0] ?? '';
    expect(firstSystem.startsWith(`<!-- request ${jobId} -->`)).toBe(true);
    /* Round 1 onward carries the stable prompt: measured safe, and it is what
       the provider can cache across the rest of the run. */
    const secondSystem = systemAtCall[1] ?? '';
    expect(secondSystem.startsWith('<!-- request')).toBe(false);
  });

  it('retries once when the provider leaks an end-of-turn token as an empty completion', async () => {
    script = [
      { content: '' },
      { tool_calls: [{ id: 'call_1', function: { name: 'run_code', arguments: JSON.stringify({ code: 'program', label: 'probe' }) } }] },
      { content: 'Grounded answer [1]' },
    ];
    const events: EngineEvent[] = [];
    /* Floor zeroed: this test is about the empty retry, not the evidence floor. */
    const preset = { ...resolveResearchPreset('default'), minFetchCalls: 0, minSearchCalls: 0 };
    await agenticResearchStream('question', undefined, (event) => events.push(event), 'default', { jobId, preset });

    expect(events.find((event) => event.type === 'error')).toBeUndefined();
    const researchRounds = llmCalls.filter((call) => call.label?.startsWith('code-round'));
    expect(researchRounds.length).toBe(3);
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toBe('Grounded answer [1]');
  });

  it('gives the classic engine the same single empty-completion retry', async () => {
    setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: false } });
    script = [{ content: '' }, { content: 'Classic answer' }];
    const events: EngineEvent[] = [];
    /* Floor zeroed: this test is about the empty retry, not the evidence floor. */
    const preset = { ...resolveResearchPreset('default'), minFetchCalls: 0, minSearchCalls: 0 };
    await agenticResearchStream('question', undefined, (event) => events.push(event), 'default', { jobId, preset });

    expect(events.find((event) => event.type === 'error')).toBeUndefined();
    expect(llmCalls.length).toBe(2);
    const done = events.find((event) => event.type === 'done') as { response?: { answer?: string } } | undefined;
    expect(done?.response?.answer).toContain('Classic answer');
  });

});
