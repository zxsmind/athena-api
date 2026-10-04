export type PlanItemStatus = 'pending' | 'done' | 'failed';

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
  /** Source numbers that closed this item. Required on done. */
  evidence?: number[];
}

/** One item of an edit_plan call, as the model sent it. */
export interface PlanEditItem {
  text: unknown;
  status: unknown;
  evidence?: unknown;
}

/**
 * Mechanical check on a plan edit: a done item must point at sources the job
 * has actually seen. The engine owns this minimum; judging whether the
 * sources really cover the item stays with the model. Returns human-readable
 * problems so the model can fix the edit in one retry.
 */
export function validatePlanEditItems(
  items: PlanEditItem[],
  knownSources: ReadonlySet<number>,
): string[] {
  const problems: string[] = [];
  for (const item of items) {
    const text = typeof item.text === 'string' ? item.text : '';
    const label = text.length > 80 ? `${text.slice(0, 80)}…` : text || '(unnamed item)';
    if (item.status !== 'done') continue;
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
      problems.push(`"${label}" is marked done without evidence: attach the source numbers that closed it.`);
      continue;
    }
    const unknown = item.evidence.filter(
      (n) => typeof n !== 'number' || !Number.isInteger(n) || !knownSources.has(n),
    );
    if (unknown.length > 0) {
      problems.push(`"${label}" cites unknown sources (${unknown.join(', ')}): use numbers from the current source index.`);
    }
  }
  return problems;
}

export interface ResearchPlan {
  goal: string;
  items: PlanItem[];
}

export interface PlanReadArgs {
  /** Byte offset to start reading from. */
  offset?: number;
  /** Maximum bytes to return for this call. */
  limit?: number;
}

export interface PlanReadResult {
  content: string;
  truncated: boolean;
  totalBytes: number;
  nextOffset: number | null;
}

function statusIcon(status: PlanItemStatus): string {
  return status === 'done' ? '[done]' : status === 'failed' ? '[failed]' : '[pending]';
}

/** Counts so the model can see progress without reading the whole plan. */
export function planSummary(plan: ResearchPlan | null): string {
  if (!plan || plan.items.length === 0) return 'No research plan yet.';
  const done = plan.items.filter((i) => i.status === 'done').length;
  const failed = plan.items.filter((i) => i.status === 'failed').length;
  const pending = plan.items.length - done - failed;
  return `${plan.items.length} items: ${done} done, ${pending} pending, ${failed} failed.`;
}

function planText(plan: ResearchPlan): string {
  const items = plan.items.map((i) => {
    const refs = i.status === 'done' && i.evidence && i.evidence.length > 0 ? ` [sources ${i.evidence.join(', ')}]` : '';
    return `- ${statusIcon(i.status)} ${i.text}${refs}`;
  }).join('\n');
  return `**Research Plan:**\nGoal: ${plan.goal}\n${items}\n`;
}

/**
  * Cursor-based read: the model pages through the plan without loading it whole.
 *
 * The plan used to be re-injected every round. That cost the same bytes on every
 * turn, grew with the checklist, and left the prefix uncacheable, even though
 * `create_plan` and `edit_plan` both already return the plan as a tool result.
 */
export function planForModel(plan: ResearchPlan | null, args: PlanReadArgs = {}): PlanReadResult {
  if (!plan) {
    return { content: 'No research plan yet. Use create_plan before your first search.', truncated: false, totalBytes: 0, nextOffset: null };
  }
  const text = planText(plan);
  const totalBytes = Buffer.byteLength(text, 'utf-8');

  const start = typeof args.offset === 'number' && Number.isFinite(args.offset)
    ? Math.max(0, Math.min(Math.trunc(args.offset), totalBytes))
    : 0;
  const requested = typeof args.limit === 'number' && Number.isFinite(args.limit)
    ? Math.max(0, Math.trunc(args.limit))
    : totalBytes;
  const limit = Math.min(requested, totalBytes);

  const startChar = byteOffsetToCharIndex(text, start);
  const endChar = byteOffsetToCharIndex(text, Math.min(start + limit, totalBytes));
  const slice = text.slice(startChar, Math.max(startChar + 1, endChar));

  const consumed = Buffer.byteLength(slice, 'utf-8');
  const nextOffset = start + consumed < totalBytes ? start + consumed : null;

  let content = slice;
  if (nextOffset !== null) {
    content = `[Plan bytes ${start}-${start + consumed} of ${totalBytes}. More follows — call read_plan with offset ${nextOffset} to continue.]\n\n${slice}`;
  }
  return { content, truncated: nextOffset !== null, totalBytes, nextOffset };
}

function byteOffsetToCharIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes >= byteOffset) return i;
    bytes += Buffer.byteLength(text[i], 'utf-8');
  }
  return text.length;
}

export const CREATE_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'create_plan',
    description: 'Create a research plan with a goal and checklist. Search first so the plan is written from results, not guesses: a plan with no prior search or fetch is rejected. The plan is not in your context afterwards; use read_plan to see it again.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Clear statement of what this research aims to achieve and verify.' },
        items: {
          type: 'array',
          minItems: 1,
          description: 'Specific, actionable research items. Break the question into distinct evidence needs.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'What to investigate or verify.' },
            },
            required: ['text'],
          },
        },
      },
      required: ['goal', 'items'],
    },
  },
} as const;

export const READ_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'read_plan',
    description: 'Read the current research plan. The plan is NOT in your context; you see only a count of done/pending/failed items. Call this to see which items remain before choosing the next step.',
    parameters: {
      type: 'object',
      properties: {
        offset: { type: 'number', description: 'Byte offset to start from. Omit to read from the start.' },
        limit: { type: 'number', description: 'Maximum bytes to return in this call. Omit for the default.' },
      },
    },
  },
} as const;

export const EDIT_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'edit_plan',
    description: 'Update the research plan: mark items as done/failed, add new items, or revise the goal. Send the full updated list — existing items keep their status unless you change it. A done item points at the sources that closed it with evidence; numbers the job has not seen are rejected. Call read_plan first if you need the current list.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Optionally revise the goal.' },
        items: {
          type: 'array',
          description: 'Full updated checklist with status for every item.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'done', 'failed'] },
              evidence: { type: 'array', items: { type: 'number' }, description: 'Source numbers that closed this item. Required when status is done.' },
            },
            required: ['text', 'status'],
          },
        },
      },
      required: ['items'],
    },
  },
} as const;
