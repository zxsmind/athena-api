export interface ResearchBudgetState {
  remainingCredits: number;
  usedCredits: number;
  exhausted: boolean;
}

export interface ResearchRunOptions {
  budget?: Partial<ResearchBudgetState>;
  onProgress?: (state: ResearchBudgetState) => void;
  signal?: AbortSignal;
}

export type SourceWithIndex = import('../schemas.js').Source & { source_index: number };

export type TokenCb = (text: string) => void;

export type EngineEvent =
  | { type: 'step'; data: import('../schemas.js').AgentStep }
  | { type: 'token'; text: string }
  | { type: 'sources'; sources: import('../schemas.js').Source[] }
  | { type: 'done'; response: import('../schemas.js').SearchResponse }
  | { type: 'error'; message: string; finalContext?: string };

export const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for real-time information. Generate compact retrieval phrases, not conversational questions. User-provided entities are source-of-truth text: preserve names, model numbers, versions, dates, acronyms, codes, quoted terms, and numeric constraints exactly. If an entity is unfamiliar or surprising, search it as written and verify it rather than replacing it with a familiar neighbor. Choose query language by source availability for surrounding retrieval terms. Break distinct information needs into separate queries.',
    parameters: {
      type: 'object',
      properties: {
        search_query: { type: 'string', description: 'A compact search phrase for one evidence need.' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Multiple compact search phrases, one per distinct evidence need.' },
        type: { type: 'string', enum: ['search', 'news', 'images', 'videos', 'places', 'shopping', 'scholar', 'patents'], description: 'Type of search to perform.' },
      },
    },
  },
} as const;

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
