export interface SearchRequest {
  query: string;
  mode?: string;
  depth?: import('./engine/depth-presets.js').DeepDepth;
  history?: { role: string; content: string }[];
  conversationId?: string;
}

export interface Source {
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
  research_budget?: {
    used: number;
    limit: number;
    exhausted: boolean;
  };
  research_notebook?: {
    id: string;
    path: string;
    entries: number;
    updatedAt: string;
  };
  research_depth?: import('./engine/depth-presets.js').DeepDepth;
}

export interface Message {
  type: 'user' | 'assistant';
  content: string;
  data?: SearchResponse;
  error?: string;
  loading?: boolean;
}
