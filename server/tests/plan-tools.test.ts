import { describe, it, expect } from 'vitest';
import {
  planForModel,
  planSummary,
  validatePlanEditItems,
  CREATE_PLAN_TOOL,
  EDIT_PLAN_TOOL,
  READ_PLAN_TOOL,
  type ResearchPlan,
} from '../src/engine/plan-tools.js';

const plan = (): ResearchPlan => ({
  goal: 'Determine the current premium and who qualifies',
  items: [
    { text: 'Official 2026 tariff table', status: 'done' },
    { text: 'Eligibility rules for self-employed', status: 'pending' },
    { text: 'Whether the 2025 figure was revised', status: 'failed' },
  ],
});

describe('plan reads', () => {
  it('reports progress without the item text', () => {
    const summary = planSummary(plan());
    expect(summary).toContain('3 items');
    expect(summary).toContain('1 done');
    expect(summary).toContain('1 pending');
    expect(summary).toContain('1 failed');
    /* The summary is what the model always sees, so it must stay cheap. */
    expect(summary).not.toContain('tariff table');
  });

  it('reports no plan instead of failing', () => {
    expect(planSummary(null)).toContain('No research plan');
    const read = planForModel(null);
    expect(read.content).toContain('create_plan');
    expect(read.nextOffset).toBeNull();
  });

  it('returns the whole plan when no range is given', () => {
    const read = planForModel(plan());
    expect(read.content).toContain('Official 2026 tariff table');
    expect(read.content).toContain('self-employed');
    expect(read.nextOffset).toBeNull();
  });

  it('pages through a plan and reports the next offset', () => {
    const first = planForModel(plan(), { offset: 0, limit: 40 });
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBeGreaterThan(0);

    const second = planForModel(plan(), { offset: first.nextOffset!, limit: 40 });
    expect(second.nextOffset).toBeGreaterThan(first.nextOffset!);
    expect(second.content).not.toBe(first.content);
  });

  it('keeps byte offsets aligned with multi-byte characters', () => {
    const unicode: ResearchPlan = {
      goal: 'Türkçe plan: ücret ve uygunluk',
      items: [
        { text: 'Resmî ücret tablosu', status: 'done' },
        { text: '日本語の項目', status: 'pending' },
      ],
    };
    const read = planForModel(unicode, { offset: 0, limit: 5_000 });
    expect(read.content).toContain('Türkçe plan');
    expect(read.content).toContain('日本語の項目');
  });

  it('treats an out-of-range offset as the end rather than throwing', () => {
    const read = planForModel(plan(), { offset: 999_999 });
    expect(read.truncated).toBe(false);
    expect(read.nextOffset).toBeNull();
  });
});

describe('plan tool schemas', () => {
  it('exposes a read tool next to create and edit', () => {
    expect(READ_PLAN_TOOL.function.name).toBe('read_plan');
    expect(Object.keys(READ_PLAN_TOOL.function.parameters.properties)).toEqual(['offset', 'limit']);
  });

  it('tells the model the plan is not in its context', () => {
    expect(READ_PLAN_TOOL.function.description).toMatch(/NOT in your context/);
    expect(CREATE_PLAN_TOOL.function.description).toMatch(/read_plan/);
    expect(EDIT_PLAN_TOOL.function.description).toMatch(/read_plan/);
  });

  it('rejects a plan written before any research, in the schema itself', () => {
    expect(CREATE_PLAN_TOOL.function.description).toMatch(/rejected/);
    expect(CREATE_PLAN_TOOL.function.description).not.toMatch(/before making your first search/);
  });
});

describe('plan edit validation', () => {
  const known = new Set([1, 2, 3]);

  it('rejects a done item without evidence', () => {
    const problems = validatePlanEditItems([{ text: 'Check records', status: 'done' }], known);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/without evidence/);
  });

  it('rejects a done item citing unknown sources', () => {
    const problems = validatePlanEditItems([{ text: 'Check records', status: 'done', evidence: [9] }], known);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/unknown sources/);
  });

  it('rejects non-integer evidence', () => {
    const problems = validatePlanEditItems(
      [{ text: 'Check records', status: 'done', evidence: [1.5, '2'] }],
      known,
    );
    expect(problems).toHaveLength(1);
  });

  it('accepts a done item pointing at seen sources', () => {
    expect(validatePlanEditItems([{ text: 'Check records', status: 'done', evidence: [1, 3] }], known)).toEqual([]);
  });

  it('leaves pending and failed items alone', () => {
    expect(validatePlanEditItems([
      { text: 'Open question', status: 'pending' },
      { text: 'Dead end', status: 'failed' },
    ], known)).toEqual([]);
  });

  it('shows the closing sources when the plan is read back', () => {
    const read = planForModel({
      goal: 'g',
      items: [{ text: 'Check records', status: 'done', evidence: [1, 3] }],
    });
    expect(read.content).toMatch(/\[sources 1, 3\]/);
  });
});
