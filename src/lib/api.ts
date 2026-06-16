export interface Source {
  title: string;
  url: string;
  domain: string;
  snippet?: string | null;
  image?: string | null;
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
  research_budget?: {
    used: number;
    limit: number;
    exhausted: boolean;
  };
}

export interface Message {
  type: 'user' | 'assistant';
  content: string;
  data?: SearchResponse;
  error?: string;
  loading?: boolean;
  streaming?: boolean;
  timerMs?: number;
  activeSteps?: AgentStep[];
  searches?: { query: string; status: 'searching' | 'searched'; duration_ms?: number; type?: 'search' | 'webpage'; model?: string }[];
}

export interface ConversationMeta {
  id: string;
  query: string;
  title: string | null;
  timestamp: string;
}

export type ResearchJobStatus = 'queued' | 'planning' | 'searching' | 'reviewing' | 'synthesizing' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ResearchJobRequest {
  query: string;
  history?: { role: string; content: string }[];
  mode?: 'quick' | 'deep';
}

export interface ResearchJobRecord {
  id: string;
  query: string;
  history?: { role: string; content: string }[];
  mode: 'quick' | 'deep';
  status: ResearchJobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  cancelled: boolean;
  steps?: AgentStep[];
  result?: SearchResponse;
}

export type ResearchBatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ResearchBatchRequest {
  queries: string[];
  history?: { role: string; content: string }[];
  mode?: 'quick' | 'deep';
  maxConcurrent?: number;
  sharedCredits?: number;
  perItemCredits?: number;
}

export interface ResearchBatchItem {
  id: string;
  query: string;
  status: ResearchBatchStatus | 'pending';
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ResearchBatchRecord {
  id: string;
  queries: string[];
  history?: { role: string; content: string }[];
  mode: 'quick' | 'deep';
  maxConcurrent: number;
  sharedCredits: number;
  perItemCredits: number;
  status: ResearchBatchStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelled: boolean;
  items: ResearchBatchItem[];
}

const BASE = '/api';

export type ResearchJobEvent =
  | { type: 'status'; status: ResearchJobStatus; detail?: string; timestamp: string }
  | { type: 'step'; data: AgentStep; timestamp: string }
  | { type: 'token'; text: string; timestamp: string }
  | { type: 'sources'; sources: Source[]; timestamp: string }
  | { type: 'done'; response: SearchResponse; timestamp: string }
  | { type: 'error'; message: string; timestamp: string };

/* ── Search: creates a job, returns ID — frontend streams events via /research-jobs/:id/events ── */
export interface SearchResult {
  id: string;
}

export async function search(
  query: string,
  history?: { role: string; content: string }[],
  mode?: 'quick' | 'deep',
  signal?: AbortSignal,
): Promise<SearchResult> {
  const res = await fetch(`${BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, history, mode }),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }

  return res.json();
}

/* ── Subscribe to research job events via SSE ── */
export interface JobEventCallbacks {
  onToken?: (text: string) => void;
  onStep?: (step: AgentStep) => void;
  onSources?: (sources: Source[]) => void;
  onDone?: (response: SearchResponse) => void;
  onError?: (message: string) => void;
  onStatus?: (status: ResearchJobStatus) => void;
}

export function subscribeToJobEvents(
  jobId: string,
  callbacks: JobEventCallbacks,
  signal?: AbortSignal,
): () => void {
  const url = `${BASE}/research-jobs/${jobId}/events`;
  const source = new EventSource(url);

  const eventTypes = ['status', 'step', 'token', 'sources', 'done', 'error'] as const;
  for (const type of eventTypes) {
    source.addEventListener(type, (e: MessageEvent) => {
      if (signal?.aborted) return;
      try {
        const data = JSON.parse(e.data) as ResearchJobEvent;
        switch (data.type) {
          case 'token': callbacks.onToken?.(data.text); break;
          case 'step': callbacks.onStep?.(data.data); break;
          case 'sources': callbacks.onSources?.(data.sources); break;
          case 'done': callbacks.onDone?.(data.response); break;
          case 'error': callbacks.onError?.(data.message); break;
          case 'status': callbacks.onStatus?.(data.status); break;
        }
      } catch { /* skip malformed */ }
    });
  }

  source.onerror = () => {
    source.close();
  };

  if (signal) {
    signal.addEventListener('abort', () => source.close(), { once: true });
  }

  return () => source.close();
}

/* ── REST endpoints ── */
export async function fetchConversations(): Promise<ConversationMeta[]> {
  const res = await fetch(`${BASE}/conversations`);
  if (!res.ok) return [];
  return res.json();
}

export async function createConversation(id: string, query: string): Promise<ConversationMeta[]> {
  const res = await fetch(`${BASE}/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, query }),
  });
  return res.json();
}

export async function fetchMessages(conversationId: string): Promise<Message[]> {
  const res = await fetch(`${BASE}/conversations/${conversationId}/messages`);
  if (!res.ok) return [];
  return res.json();
}

export async function saveMessages(conversationId: string, messages: Message[]): Promise<void> {
  await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await fetch(`${BASE}/conversations/${id}/rename`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await fetch(`${BASE}/conversations/${id}`, {
    method: 'DELETE',
  });
}

export async function createResearchJob(payload: ResearchJobRequest): Promise<ResearchJobRecord> {
  const res = await fetch(`${BASE}/research-jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function fetchResearchJob(id: string): Promise<ResearchJobRecord | null> {
  const res = await fetch(`${BASE}/research-jobs/${id}`);
  if (!res.ok) return null;
  return res.json();
}

export async function cancelResearchJob(id: string): Promise<ResearchJobRecord | null> {
  const res = await fetch(`${BASE}/research-jobs/${id}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) return null;
  return res.json();
}

export async function createResearchBatch(payload: ResearchBatchRequest): Promise<ResearchBatchRecord> {
  const res = await fetch(`${BASE}/research-batches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function fetchResearchBatch(id: string): Promise<ResearchBatchRecord | null> {
  const res = await fetch(`${BASE}/research-batches/${id}`);
  if (!res.ok) return null;
  return res.json();
}

export async function cancelResearchBatch(id: string): Promise<ResearchBatchRecord | null> {
  const res = await fetch(`${BASE}/research-batches/${id}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) return null;
  return res.json();
}
