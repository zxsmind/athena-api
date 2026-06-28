export type PlanItemStatus = 'pending' | 'done' | 'failed';

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
}

export interface ResearchPlan {
  goal: string;
  items: PlanItem[];
}

export function planContextBlock(plan: ResearchPlan | null): string {
  if (!plan) return '';
  const items = plan.items.map(i => {
    const icon = i.status === 'done' ? '[done]'
      : i.status === 'failed' ? '[failed]'
      : '[pending]';
    return `- ${icon} ${i.text}`;
  }).join('\n');
  return `**Research Plan:**\nGoal: ${plan.goal}\n${items}`;
}

export const CREATE_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'create_plan',
    description: 'Create a research plan with a goal and checklist. Call this before making your first search to organize your approach.',
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

export const EDIT_PLAN_TOOL = {
  type: 'function',
  function: {
    name: 'edit_plan',
    description: 'Update the research plan: mark items as done/failed, add new items, or revise the goal. Send the full updated list — existing items keep their status unless you change it.',
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
            },
            required: ['text', 'status'],
          },
        },
      },
      required: ['items'],
    },
  },
} as const;
