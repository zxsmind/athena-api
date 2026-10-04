import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config/defaults.js';
import { resetConfigForTests, setConfig } from '../src/config/load.js';
import { createBudgetState, resolveResearchPreset } from '../src/engine/modes.js';
import { createSandboxHandlers, type SandboxHandlerContext } from '../src/engine/sandbox-handlers.js';
import type { ResearchPlan } from '../src/engine/plan-tools.js';
import type { SourceWithIndex } from '../src/engine/types.js';

vi.mock('../src/search/index.js', () => ({
  searchResults: vi.fn(async (query: string) => ({
    results: [{ title: `Hit for ${query}`, url: `https://example.com/${encodeURIComponent(query)}`, snippet: 's'.repeat(900) }],
    queryText: query,
    provider: 'mock',
  })),
  extractPageContent: vi.fn(async (url: string) => {
    if (url.includes('broken')) return { title: url, content: '', error: 'unreadable' };
    return {
      title: `Page ${url}`,
      content: `Intro paragraph with nothing relevant.\n\nThe solid electrolyte conductivity reaches record values in this passage about batteries.\n\nClosing remarks on an unrelated topic.`,
    };
  }),
}));

import { extractPageContent, searchResults } from '../src/search/index.js';

function context(): SandboxHandlerContext {
  return {
    allSources: new Map<string, SourceWithIndex>(),
    budget: createBudgetState(),
    preset: resolveResearchPreset('instant'),
    round: 0,
    publishSources: () => undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: false } });
});

afterEach(() => {
  resetConfigForTests();
});

describe('sandbox search', () => {
  it('caps one call at a classic batch and reports the dropped remainder', async () => {
    const ctx = context();
    const handlers = createSandboxHandlers(ctx);
    const queries = Array.from({ length: 15 }, (_, i) => `q${i}`);
    const result = (await handlers.search({ queries })) as { results: unknown[]; dropped?: number };
    expect(result.results).toHaveLength(12);
    expect(result.dropped).toBe(3);
    expect(ctx.budget.usedSearchCalls).toBe(12);
  });

  it('keeps snippets compact', async () => {
    const ctx = context();
    const handlers = createSandboxHandlers(ctx);
    const result = (await handlers.search({ queries: ['alpha'] })) as { results: { snippet: string }[] };
    expect(result.results[0].snippet.length).toBeLessThanOrEqual(200);
  });

  it('stops at the ceiling without charging', async () => {
    const ctx = context();
    ctx.budget.usedSearchCalls = ctx.preset.maxSearchCalls;
    const handlers = createSandboxHandlers(ctx);
    const result = (await handlers.search({ queries: ['alpha'] })) as { error?: string };
    expect(result.error).toMatch(/ceiling/);
    expect(searchResults).not.toHaveBeenCalled();
  });

  it('warns once when the allowance runs low, then goes quiet', async () => {
    const ctx = context();
    /* Instant ceiling is 15: warning fires at 4 or fewer remaining. */
    ctx.budget.usedSearchCalls = 10;
    const handlers = createSandboxHandlers(ctx);
    const first = (await handlers.search({ queries: ['alpha'] })) as { warning?: string };
    expect(first.warning).toMatch(/nearly spent \(11\/15 used\)/);
    const second = (await handlers.search({ queries: ['beta'] })) as { warning?: string };
    expect(second.warning).toBeUndefined();
  });

  it('stays quiet while the allowance is healthy', async () => {
    const ctx = context();
    const handlers = createSandboxHandlers(ctx);
    const result = (await handlers.search({ queries: ['alpha'] })) as { warning?: string };
    expect(result.warning).toBeUndefined();
  });

  it('carries running counters on every search and extract answer', async () => {
    const ctx = context();
    const handlers = createSandboxHandlers(ctx);
    const searched = (await handlers.search({ queries: ['alpha', 'beta'] })) as {
      usage: { used_search_calls: number; search_calls_limit: number; used_fetch_calls: number };
    };
    expect(searched.usage).toMatchObject({
      used_search_calls: 2,
      search_calls_limit: ctx.preset.maxSearchCalls,
      used_fetch_calls: 0,
    });
    const extracted = (await handlers.extract({ urls: ['https://example.com/a'] })) as {
      usage: { used_search_calls: number; used_fetch_calls: number };
    };
    expect(extracted.usage).toMatchObject({ used_search_calls: 2, used_fetch_calls: 1 });
  });
});

describe('sandbox extract', () => {
  it('reads a batch and returns question-targeted excerpts', async () => {
    const ctx = context();
    const handlers = createSandboxHandlers(ctx);
    const result = (await handlers.extract({
      urls: ['https://example.com/a', 'https://example.com/b'],
      question: 'solid electrolyte conductivity batteries',
    })) as { pages: { n: number; excerpts: { text: string }[] }[] };
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].n).toBe(1);
    expect(result.pages[1].n).toBe(2);
    expect(result.pages[0].excerpts[0].text).toContain('solid electrolyte conductivity');
    expect(ctx.budget.usedFetchCalls).toBe(2);
  });

  it('clips the page head without a question', async () => {
    const ctx = context();
    const handlers = createSandboxHandlers(ctx);
    const result = (await handlers.extract({ urls: ['https://example.com/a'] })) as {
      pages: { excerpts: { text: string }[] }[];
    };
    expect(result.pages[0].excerpts[0].text).toContain('Intro paragraph');
  });

  it('caps pages per call and keeps per-page errors local', async () => {
    const ctx = context();
    const handlers = createSandboxHandlers(ctx);
    const urls = ['https://example.com/1', 'https://example.com/2', 'https://example.com/broken', 'https://example.com/4', 'https://example.com/5'];
    const result = (await handlers.extract({ urls, question: 'batteries' })) as {
      pages: ({ n?: number; error?: string })[];
      dropped?: number;
    };
    expect(result.pages).toHaveLength(4);
    expect(result.dropped).toBe(1);
    expect(result.pages[2]).toMatchObject({ url: 'https://example.com/broken' });
    expect(result.pages.filter((page) => page.n)).toHaveLength(3);
    expect(extractPageContent).toHaveBeenCalledTimes(4);
  });

  it('rejects an empty url list', async () => {
    const ctx = context();
    const handlers = createSandboxHandlers(ctx);
    const result = (await handlers.extract({ urls: [] })) as { error?: string };
    expect(result.error).toMatch(/urls/);
  });
});

describe('sandbox plan', () => {
  function plannedContext(): SandboxHandlerContext & {
    planRef: { current: ResearchPlan | null };
    declinedRef: { reason: string | null };
  } {
    return {
      ...context(),
      planRef: { current: null },
      declinedRef: { reason: null },
    };
  }

  it('rejects a plan written before any search or extract', async () => {
    const ctx = plannedContext();
    const handlers = createSandboxHandlers(ctx);
    const result = (await handlers.plan({ goal: 'g', items: [{ text: 'Check records' }] })) as { error?: string };
    expect(result.error).toMatch(/rejected/);
    expect(ctx.planRef.current).toBeNull();
  });

  it('creates the plan after reconnaissance and reads it back', async () => {
    const ctx = plannedContext();
    ctx.budget.usedSearchCalls = 1;
    const handlers = createSandboxHandlers(ctx);
    const created = (await handlers.plan({ goal: 'g', items: [{ text: 'Check records' }] })) as { ok?: boolean };
    expect(created.ok).toBe(true);
    const read = (await handlers.plan_read({})) as { content: string };
    expect(read.content).toContain('Check records');
  });

  it('rejects done items without seen sources and accepts them with', async () => {
    const ctx = plannedContext();
    ctx.budget.usedSearchCalls = 1;
    const handlers = createSandboxHandlers(ctx);
    await handlers.plan({ goal: 'g', items: [{ text: 'Check records' }] });
    await handlers.search({ queries: ['alpha'] });
    const bad = (await handlers.plan_update({
      items: [{ text: 'Check records', status: 'done' }],
    })) as { ok?: boolean; error?: string };
    expect(bad.ok).toBeFalsy();
    expect(bad.error).toMatch(/without evidence/);
    const good = (await handlers.plan_update({
      items: [{ text: 'Check records', status: 'done', evidence: [1] }],
    })) as { ok?: boolean; summary?: string };
    expect(good.ok).toBe(true);
    expect(good.summary).toContain('1 done');
  });

  it('reports the budget as data and records a decline', async () => {
    const ctx = plannedContext();
    ctx.budget.usedSearchCalls = 3;
    const handlers = createSandboxHandlers(ctx);
    const reading = (await handlers.budget({})) as { ok?: boolean; budget: Record<string, number> };
    expect(reading.ok).toBe(true);
    expect(reading.budget.used_search_calls).toBe(3);
    expect(reading.budget.search_calls_remaining).toBe(ctx.preset.maxSearchCalls - 3);
    const declined = (await handlers.decline({ reason: 'Just a greeting.' })) as { ok?: boolean };
    expect(declined.ok).toBe(true);
    expect(ctx.declinedRef.reason).toBe('Just a greeting.');
  });
});
