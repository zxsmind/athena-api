export interface ResearchBudgetState {
  remainingCredits: number;
  usedCredits: number;
  exhausted: boolean;
}

export interface ResearchProgressState extends ResearchBudgetState {
  round?: number;
  depth?: import('./depth-presets.js').DeepDepth;
  notebookId?: string;
  notebookUpdates?: number;
  sourceMap?: SourceWithIndex[];
}

export interface ResearchRunOptions {
  budget?: Partial<ResearchBudgetState>;
  onProgress?: (state: ResearchProgressState) => void;
  signal?: AbortSignal;
  depth?: import('./depth-presets.js').DeepDepth;
  preset?: import('./depth-presets.js').ResolvedResearchPreset;
  jobId?: string;
}

export type SourceWithIndex = import('../schemas.js').Source & { source_index: number };

export type TokenCb = (text: string) => void;

export type EngineEvent =
  | { type: 'step'; data: import('../schemas.js').AgentStep }
  | { type: 'token'; text: string }
  | { type: 'message_segment' }
  | { type: 'sources'; sources: import('../schemas.js').Source[] }
  | { type: 'context'; finalContext: string }
  | { type: 'done'; response: import('../schemas.js').SearchResponse }
  | { type: 'error'; message: string; finalContext?: string };

export function createSearchTool(maxQueries: number): { type: 'function'; function: { name: string; description: string; parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] } } } {
  return {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Break distinct information needs into separate queries — use one array entry per need. Preserve user-provided names, numbers, and terms exactly.',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: maxQueries,
            description: `One or more compact search phrases. Each entry targets one distinct evidence need. Never collapse multiple needs into a single string — use one array entry per need. Maximum ${maxQueries} queries per call.`,
          },
          type: { type: 'string', enum: ['search', 'news', 'images', 'videos', 'places', 'shopping', 'scholar', 'patents'], description: 'Type of search to perform.' },
        },
        required: ['queries'],
      },
    },
  };
}

export const FETCH_URL_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description: 'Fetch and read the full content of a specific web page.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to fetch, including https://' },
      },
      required: ['url'],
    },
  },
} as const;
