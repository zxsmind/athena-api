export interface ResearchProgressState {
  /** Display snapshot of every ceiling and its current use. */
  budget: import('./modes.js').BudgetSnapshot;
  /** Live counters, needed to persist and resume a job. */
  budgetState: import('./modes.js').BudgetState;
  round: number;
  mode: import('./modes.js').ResearchMode;
  sourceMap?: SourceWithIndex[];
}

export interface ResearchRunOptions {
  onProgress?: (state: ResearchProgressState) => void;
  signal?: AbortSignal;
  /** Direct-call experiment switch; the API does not expose it. Defaults to true. */
  planningEnabled?: boolean;
  mode?: import('./modes.js').ResearchMode;
  preset?: import('./modes.js').ResearchPreset;
  jobId?: string;
  researchApi?: boolean;
  /** What the caller sees while the job runs. Does not change the answer. */
  verbosity?: import('./modes.js').ResearchVerbosity;
  /** How long the answer should be. Names one of the prompt's length specs. */
  responseLength?: import('./modes.js').ResponseLength;
}

export type SourceWithIndex = import('../schemas.js').Source & { source_index: number };

export type TokenCb = (text: string) => void;

export type EngineEvent =
  | { type: 'step'; data: import('../schemas.js').AgentStep }
  /* A progress note the model published with report_progress. Distinct from a
     step: it is not research the engine did, and it never consumes budget. */
  | { type: 'progress'; data: import('./progress.js').ProgressNote }
  | { type: 'token'; text: string }
  /* The model declined the request as not researchable. Terminal: the runner
     marks the job declined and bills work done so far. */
  | { type: 'declined'; reason: string }
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

/**
 * `fetch_url` takes a list, like `web_search` takes a list of queries.
 *
 * A measured run issued eleven separate fetches, four of them in one response,
 * where a single four-entry call would have covered the same pages. Each call
 * costs a round trip and, more importantly, a model turn. The cap exists because
 * the responses come back into one context: unbounded, a list of URLs would
 * return more text per turn than the model can read, which is the opposite of
 * the saving.
 */
/** Pages per `fetch_url` call. Four, because the responses share one context. */
export const MAX_URLS_PER_FETCH_CALL = 4;

/**
 * Key under which one URL's extraction is stored while a batch is in flight.
 *
 * A single `fetch_url` call carries up to four URLs, and one call id covers all
 * of them, so the call id alone cannot tell the four results apart. Both the
 * write and the read must derive the key through this function: deriving it
 * differently on each side leaves every URL but the first looking absent, and
 * the failure surfaces only when a page actually fails to extract, which is not
 * something a schema test can reach.
 */
export function fetchResultsKey(tcId: string, position: number): string {
  return `${tcId}#${position}`;
}

export const FETCH_URL_TOOL = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description: 'Fetch and read the full content of web pages. One array entry per page.',
    parameters: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_URLS_PER_FETCH_CALL,
          description: `Full URLs to fetch, including https://. One entry per page. Maximum ${MAX_URLS_PER_FETCH_CALL} pages per call.`,
        },
      },
      required: ['urls'],
    },
  },
} as const;

export const READ_BUDGET_TOOL_NAME = 'read_budget';

/**
 * On-demand budget reading. The agent sizes its own batches from this instead
 * of the engine injecting a per-round manifest: re-injecting state every round
 * cost ~2,500 tokens per turn, grew with the research, left nothing cacheable,
 * and once answered a preamble in four seconds without calling a tool. Like
 * `read_plan`, this is read when needed and never pushed.
 *
 * Answered after the turn's searches and fetches are charged, so the reading
 * includes the other calls in the same response. Free: no charge, no wrap-up
 * count, no step of its own when batched with research calls.
 */
export const READ_BUDGET_TOOL = {
  type: 'function',
  function: {
    name: READ_BUDGET_TOOL_NAME,
    description:
      'Read the remaining research budget: searches, page reads, steps, tokens, and time against their ceilings. Call it in the same response as a search or fetch when deciding the next batch size. The reading counts completed calls, including the other calls in that response, and spends no budget itself.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
} as const;

export const DECLINE_REQUEST_TOOL_NAME = 'decline_request';

/**
 * Escape hatch for inputs with nothing to research. Narrow by design: only a
 * request that is not a research question at all (a greeting, an empty or
 * incomprehensible message) may end here. A hard, contested, or partially
 * unverifiable question is researched and reported with gaps instead. Every
 * decline is traced and counted, so abuse reads as a rate, not a suspicion.
 */
export const DECLINE_REQUEST_TOOL = {
  type: 'function',
  function: {
    name: DECLINE_REQUEST_TOOL_NAME,
    description:
      'Decline the request without researching. Call this only when the input is not a research question at all: a greeting, an empty message, or an incomprehensible string. State why in reason. A difficult, contested, or partially unverifiable question is researched instead, with the gaps reported. The job ends as declined and work done so far is billed.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why this input is not a research question, in one sentence.',
        },
      },
      required: ['reason'],
    },
  },
} as const;

export const RUN_CODE_TOOL_NAME = 'run_code';

/**
 * Code execution is one tool, not a second loop: the program runs in the job's
 * sandbox, and only what it prints or returns re-enters the conversation. The
 * injected functions (`search`, `extract`, `read_source`) answer over JSON-RPC
 * on the engine side, where budget, source numbering and evidence live.
 */
export const RUN_CODE_TOOL = {
  type: 'function',
  function: {
    name: RUN_CODE_TOOL_NAME,
    description: 'Run a Python program in this job\'s persistent sandbox. Inside it, await search({queries:[...]}) for web results, await extract({url}) to read a page, and await read_source({n}) to re-read a stored source. Variables and `state` persist between programs. Only printed text and the last expression return to the conversation; raw page text stays in the sandbox.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python source. The value of the last expression is returned. Use print() for what you want to read. Print only the few lines you need, under 2,000 characters.',
        },
        label: { type: 'string', description: 'Short label for this program, for example "search Parallel docs".' },
      },
      required: ['code'],
    },
  },
} as const;
