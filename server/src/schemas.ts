export interface Source {
  source_index?: number;
  title: string | null;
  url: string;
  domain: string;
  snippet?: string | null;
}

export interface SearchResult {
  id: number | null;
  title: string;
  url: string;
  snippet: string | null;
  date: string | null;
  content?: string;
  extract_error?: string;
}

export interface AgentStep {
  type: string;
  query?: string;
  result_count?: number;
  note?: string;
  model?: string;
  reasoning?: string;
  duration_ms?: number;
  context?: string;
}

export interface SearchResponse {
  query: string;
  answer: string;
  sources: Source[];
  steps: AgentStep[];
  results_count: number;
  elapsed_ms: number;
  finalContext?: string;
  research_budget?: import('./engine/modes.js').BudgetSnapshot;
  mode?: import('./engine/modes.js').ResearchMode;
  reasoning_effort?: import('./engine/modes.js').ReasoningEffort;
  verbosity?: import('./engine/modes.js').ResearchVerbosity;
  /** Present on the v1 research path; the structured evidence contract. */
  report?: import('./engine/report.js').ResearchReport;
}

