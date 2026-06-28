# ATHENA-001 API Documentation

> Version 2 — Node.js Express backend

---

## Table of Contents

- [Base URL](#base-url)
- [Authentication](#authentication)
- [Common Headers](#common-headers)
- [Endpoints Overview](#endpoints-overview)
- [Search API (SSE Streaming)](#search-api-sse-streaming)
- [Research Jobs API](#research-jobs-api)
- [Research Batches API](#research-batches-api)
- [Settings API](#settings-api)
- [Conversations API](#conversations-api)
- [Utility Endpoints](#utility-endpoints)
- [Type Definitions](#type-definitions)
- [Research Budget System](#research-budget-system)
- [Provider & Model Routing](#provider--model-routing)
- [SSE Event Reference](#sse-event-reference)
- [Error Handling](#error-handling)
- [Rate Limits & Retention](#rate-limits--retention)

---

## Base URL

```
http://localhost:3001
```

In development, the Vite dev server (`http://localhost:5173`) proxies `/api/*` requests to the backend at `http://localhost:3001`, stripping the `/api` prefix. For example, a frontend `fetch('/api/search')` reaches `POST /search` on the backend.

**Configuration** (`server/data/settings.json`):

| Field | Default | Description |
|-------|---------|-------------|
| `host` | `"0.0.0.0"` | Bind address |
| `port` | `3001` | Server port |

---

## Authentication

Authentication is not implemented. The server is designed for local/trusted-network use. API keys for external services (Groq, Gemini, Serper) are stored in `server/data/settings.json` and used server-side only — they are never exposed to clients.

---

## Common Headers

| Header | Value | Notes |
|--------|-------|-------|
| `Content-Type` | `application/json` | Required for POST/PUT bodies |
| `Accept` | `application/json` | Default response format |

---

## Endpoints Overview

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/search` | Create a research job, returns `{ id }` — frontend then polls `/research-jobs/:id/events` for SSE |
| `POST` | `/research-jobs` | Create a long-running research job |
| `GET` | `/research-jobs/:id` | Get job status and result |
| `GET` | `/research-jobs/:id/events` | SSE stream of job events |
| `POST` | `/research-jobs/:id/cancel` | Cancel a running job |
| `POST` | `/research-jobs/:id/pause` | Pause a running job (checkpoint) |
| `POST` | `/research-jobs/:id/resume` | Resume a paused job |
| `GET` | `/research-batches` | List all research batches |
| `POST` | `/research-batches` | Create a batch of research queries |
| `GET` | `/research-batches/:id` | Get batch status and results |
| `GET` | `/research-batches/:id/events` | SSE stream of batch events |
| `POST` | `/research-batches/:id/cancel` | Cancel a running batch |
| `GET` | `/settings` | Get current settings |
| `PUT` | `/settings` | Update settings |
| `GET` | `/conversations` | List conversations |
| `POST` | `/conversations` | Create conversation |
| `GET` | `/conversations/:id/messages` | Get conversation messages |
| `PUT` | `/conversations/:id/messages` | Save conversation messages |
| `PUT` | `/conversations/:id/research` | Update conversation mode/depth |
| `PUT` | `/conversations/:id/rename` | Rename conversation |
| `DELETE` | `/conversations/:id` | Delete conversation |
| `GET` | `/notebooks/:id` | Get research notebook metadata and Markdown content |
| `GET` | `/health` | Server health check |
| `GET` | `/config` | Public configuration (key count, provider count) |
| `GET` | `/autocomplete` | Google Suggest-based search suggestions |
| `GET` | `/ping` | Version info |
| `POST` | `/test-llm` | Test LLM connectivity |

---

## Search API

Interactive research via a two-step pattern: create a job, then subscribe to its SSE event stream.

### `POST /search`

Create a research job. Returns immediately with the job ID. The frontend then subscribes to `GET /research-jobs/:id/events` for real-time SSE streaming.

**Request Body:**

```json
{
  "query": "What is quantum computing?",
  "history": [
    { "role": "user", "content": "Previous question" },
    { "role": "assistant", "content": "Previous answer" }
  ],
  "mode": "deep",
  "depth": "med"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | `string` | **Yes** | — | The search query |
| `history` | `Array<{role, content}>` | No | `[]` | Conversation history for context |
| `mode` | `"quick" \| "deep"` | No | `"quick"` | Research depth |
| `depth` | `"low" \| "med" \| "high" \| "ultra"` | No | `"med"` for deep | Deep preset. Ignored for quick mode |

**Response (202):**

```json
{ "id": "550e8400-e29b-41d4-a716-446655440000" }
```

### `GET /research-jobs/:id/events`

SSE stream of job events in real time.

**Response:** `text/event-stream`.

**Events:**

```
event: step
data: {"type":"step","data":{"type":"plan","query":"...","model":"...","note":"..."},"timestamp":"..."}

event: sources
data: {"type":"sources","sources":[{"title":"...","url":"...","domain":"...","snippet":"..."}]}

event: token
data: {"type":"token","text":"Partial answer text...","timestamp":"..."}

event: progress
data: {"type":"progress","data":{"usedCredits":3,"remainingCredits":32,"exhausted":false,"round":2,"depth":"med","notebookId":"...","notebookUpdates":1},"timestamp":"..."}

event: done
data: {"type":"done","response":{"query":"...","answer":"...","sources":[...],"steps":[...],"results_count":5,"elapsed_ms":4230,"research_budget":{"used":3,"limit":35,"exhausted":false},"research_depth":"med","research_notebook":{"id":"...","path":"...","updates":2,"updatedAt":"..."}},"timestamp":"..."}

event: error
data: {"type":"error","message":"Provider unavailable","timestamp":"..."}
```

**Event types:**

| Event | Data Shape | Description |
|-------|-----------|-------------|
| `step` | `{ type: "step", data: AgentStep, timestamp }` | Research phase update (plan, search, analyze, synthesize) |
| `progress` | `{ type: "progress", data: ResearchProgressState, timestamp }` | Live budget, depth, round, notebook stats during active job |
| `sources` | `{ type: "sources", sources: Source[], timestamp }` | Sources found during search |
| `context` | `{ type: "context", finalContext: string, timestamp }` | Full LLM conversation history (sent once before `done`) |
| `token` | `{ type: "token", text: string, timestamp }` | Streaming answer token |
| `done` | `{ type: "done", response: SearchResponse, timestamp }` | Final result with complete answer and sources |
| `error` | `{ type: "error", message: string, timestamp }` | Error occurred, stream ended |

The stream stays open until the job reaches a terminal state (`completed`, `failed`, `cancelled`).

**Modes:**

- **`quick`**: Instant mode. Model can call `web_search`/`fetch_url` up to 3 rounds with a 6-credit budget.
- **`deep`**: Notebook-driven research. Use `depth` to select `low`, `med`, `high`, or `ultra`. Legacy deep requests without `depth` use `med`.

**Deep presets:**

| Depth | Budget | Rounds | Purpose |
|-------|--------|--------|---------|
| `low` | 20 | 5 | Fast deep research, roughly 1-2 minutes |
| `med` | 35 | 8 | Balanced deep research, roughly 5-10 minutes |
| `high` | 50 | 13 | Aggressive verification |
| `ultra` | 100 | 30 | Long-running exhaustive research |

**Client timeout:** 3 minutes (180,000 ms). The frontend `search()` function in `src/lib/api.ts` automatically aborts after this duration.

---

## Research Jobs API

Long-running research jobs that persist in memory and can be polled or SSE-subscribed. Jobs survive until the server restarts or is pruned.

### `POST /research-jobs`

Create a new research job. Returns immediately with a `202 Accepted` status.

**Request Body:**

```json
{
  "query": "History of the Roman Empire",
  "history": [],
  "mode": "deep",
  "depth": "high"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | `string` | **Yes** | — | The research query |
| `history` | `Array<{role, content}>` | No | `[]` | Conversation context |
| `mode` | `"quick" \| "deep"` | No | settings `api.defaultMode` | Research depth |
| `depth` | `"low" \| "med" \| "high" \| "ultra"` | No | `"med"` for deep | Deep preset. Ignored for quick mode |

**Response (202):**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "query": "History of the Roman Empire",
  "mode": "deep",
  "depth": "high",
  "status": "queued",
  "createdAt": "2026-06-16T01:00:00.000Z",
  "updatedAt": "2026-06-16T01:00:00.000Z",
  "cancelled": false,
  "steps": [],
  "events": []
}
```

### `GET /research-jobs/:id`

Poll for job status and result.

**Response (200):**

```json
{
  "id": "550e8400-...",
  "query": "History of the Roman Empire",
  "mode": "deep",
  "depth": "high",
  "status": "completed",
  "createdAt": "2026-06-16T01:00:00.000Z",
  "updatedAt": "2026-06-16T01:02:30.000Z",
  "startedAt": "2026-06-16T01:00:01.000Z",
  "finishedAt": "2026-06-16T01:02:30.000Z",
  "cancelled": false,
  "steps": [
    { "type": "plan", "query": "History of the Roman Empire", "note": "Breaking down into sub-topics..." },
    { "type": "search", "query": "Rome founding republic empire timeline", "result_count": 8 }
  ],
  "result": {
    "query": "History of the Roman Empire",
    "answer": "The Roman Empire began in 27 BCE...",
    "sources": [...],
    "steps": [...],
    "results_count": 8,
    "elapsed_ms": 149000
  }
}
```

**Status: 404** — job ID not found.

**Job statuses:**

| Status | Description |
|--------|-------------|
| `queued` | Job created, waiting to start |
| `running` | Initial execution started |
| `planning` | Agent is creating a research plan |
| `searching` | Agent is searching/analyzing |
| `reviewing` | Agent is doing critical review (deep mode only) |
| `synthesizing` | Agent is generating final answer |
| `completed` | Research finished successfully, `result` is populated |
| `failed` | Research failed, `error` field contains reason |
| `cancelled` | Cancelled by user via cancel endpoint |
| `paused` | Paused by user; checkpoint saved for High/Ultra jobs |

### `GET /research-jobs/:id/events`

SSE stream of job events. Same event types as [Search API events](#get-research-jobsidevents) (`step`, `progress`, `sources`, `token`, `done`, `error`). Long-running jobs emit SSE heartbeats every 20s while active.

### `POST /research-jobs/:id/cancel`

Cancel a running job. The job's AbortController is triggered, stopping the engine mid-execution.

**Response (200):**

```json
{
  "id": "550e8400-...",
  "status": "cancelled",
  "cancelled": true,
  "finishedAt": "2026-06-16T01:01:00.000Z",
  ...
}
```

**Status: 404** — job ID not found.

### `POST /research-jobs/:id/pause`

Pause a running deep job. Saves a checkpoint when notebook runtime state is available (High/Ultra). Job status becomes `paused`.

**Response (200):** updated job record with `"status": "paused"`.

**Status: 400** — job is not in a pausable state.

### `POST /research-jobs/:id/resume`

Resume a paused job from its checkpoint. Re-queues the job and continues the agentic loop from the saved round/budget/notebook state.

**Response (202):** updated job record with `"status": "queued"` (transitions to `running` immediately).

**Status: 400** — job is not paused.

---

## Research Batches API

Batch processing for multiple research queries with concurrency control and shared budget.

### `GET /research-batches`

List all research batches, newest first.

**Response (200):**

```json
[
  {
    "id": "batch-uuid-1",
    "queries": ["What is AI?", "What is ML?"],
    "mode": "quick",
    "maxConcurrent": 2,
    "sharedCredits": 40,
    "perItemCredits": 20,
    "status": "completed",
    "createdAt": "2026-06-16T01:00:00.000Z",
    "updatedAt": "2026-06-16T01:02:30.000Z",
    "startedAt": "2026-06-16T01:00:01.000Z",
    "finishedAt": "2026-06-16T01:02:30.000Z",
    "cancelled": false,
    "items": [
      { "id": "item-uuid-1", "query": "What is AI?", "status": "completed" },
      { "id": "item-uuid-2", "query": "What is ML?", "status": "completed" }
    ]
  }
]
```

### `POST /research-batches`

Create a batch of research queries.

**Request Body:**

```json
{
  "queries": [
    "What is artificial intelligence?",
    "What is machine learning?",
    "What is deep learning?"
  ],
  "history": [],
  "mode": "quick",
  "maxConcurrent": 2,
  "sharedCredits": 60,
  "perItemCredits": 20
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `queries` | `string[]` | **Yes** | — | Array of queries to research (min 1) |
| `history` | `Array<{role, content}>` | No | `[]` | Shared conversation context |
| `mode` | `"quick" \| "deep"` | No | settings `api.defaultMode` | Research depth for all items |
| `depth` | `"low" \| "med" \| "high" \| "ultra"` | No | `"med"` for deep | Deep preset for all items |
| `maxConcurrent` | `number` | No | settings `api.defaultMaxConcurrent` (default: `2`) | Max parallel items |
| `sharedCredits` | `number` | No | `perItemCredits * queries.length` | Total research credits shared across all items |
| `perItemCredits` | `number` | No | `20` | Max credits per individual item |

**Response (202):**

```json
{
  "id": "batch-uuid",
  "queries": ["What is AI?", "..."],
  "mode": "quick",
  "maxConcurrent": 2,
  "sharedCredits": 60,
  "perItemCredits": 20,
  "status": "queued",
  "createdAt": "...",
  "items": [
    { "id": "item-1", "query": "What is AI?", "status": "pending" },
    { "id": "item-2", "query": "...", "status": "pending" }
  ],
  ...
}
```

### `GET /research-batches/:id`

Get batch status including per-item results. When items are `completed`, the `results` array contains each item's `SearchResponse`.

**Response (200):**

```json
{
  "id": "batch-uuid",
  "status": "running",
  "items": [
    { "id": "item-1", "query": "What is AI?", "status": "running", "startedAt": "..." },
    { "id": "item-2", "query": "What is ML?", "status": "completed", "finishedAt": "..." }
  ],
  "results": [
    null,
    { "query": "What is ML?", "answer": "...", "sources": [...], ... }
  ]
}
```

### `GET /research-batches/:id/events`

SSE stream of batch events.

```
event: status
data: {"type":"status","status":"running","timestamp":"..."}

event: step
data: {"type":"step","itemId":"item-1","note":"Planning...","query":"What is AI?","model":"llama-3.3-70b","timestamp":"..."}

event: item
data: {"type":"item","item":{"id":"item-1","query":"...","status":"completed"},...}

event: done
data: {"type":"done","batch":{"id":"...","status":"completed","items":[...]}}
```

### `POST /research-batches/:id/cancel`

Cancel all running and pending items in a batch.

**Budget System:**

- Each item uses `perItemCredits` from the shared pool
- When `sharedRemaining` reaches 0, remaining pending items fail with "Batch research budget exhausted"
- An item that finishes under budget returns unused credits to the pool (not currently implemented — credits are allocated upfront)

---

## Settings API

### `GET /settings`

Returns the full settings object. Keys are masked in the response.

**Response (200):**

```json
{
  "version": 2,
  "port": 3001,
  "host": "0.0.0.0",
  "providerOrder": ["groq", "gemini", "vercel", "openrouter", "custom"],
  "providers": {
    "groq": {
      "enabled": true,
      "name": "groq",
      "keys": ["gsk_...abcd"],
      "models": ["llama-3.3-70b-versatile"],
      "url": "https://api.groq.com/openai/v1/chat/completions",
      "label": "Groq"
    }
  },
  "serper": { "keys": ["serp_...wxyz"], "url": "https://google.serper.dev/search" },
  "research": { "maxCreditsPerQuery": 20, "maxFollowUpQueries": 3 },
  "modelRouting": {
    "title": { "primary": { "providerId": "groq", "model": "llama-3.3-70b-versatile" }, "fallback": [] },
    "reasoning": { "primary": { "providerId": "groq", "model": "llama-3.3-70b-versatile" }, "fallback": [] },
    "instant": { "primary": { "providerId": "groq", "model": "llama-3.3-70b-versatile" }, "fallback": [] },
    "deep": { "primary": { "providerId": "groq", "model": "llama-3.3-70b-versatile" }, "fallback": [] }
  },
  "api": {
    "defaultMaxConcurrent": 2,
    "maxActiveJobs": 50,
    "maxActiveBatches": 50,
    "maxEventsPerJob": 250,
    "maxEventsPerBatch": 300,
    "maxRetentionMinutes": 1440,
    "defaultMode": "quick"
  },
  "researchDepths": {
    "defaultDepth": "med",
    "presets": {
      "low": { "budgetCredits": 20, "maxRounds": 5, "minCooldownMs": 5000, "maxCooldownMs": 10000, "notebookCadenceRawBlocks": 4, "maxSearchesPerRound": 3, "maxFetchesPerRound": 1, "minIndependentSourcesForKeyClaims": 2, "contradictionPass": false, "primarySourcePreference": false, "exhaustiveGapReview": false, "checkpointEveryRounds": 0 },
      "med": { "budgetCredits": 35, "maxRounds": 8, "minCooldownMs": 10000, "maxCooldownMs": 15000, "notebookCadenceRawBlocks": 6, "maxSearchesPerRound": 3, "maxFetchesPerRound": 2, "minIndependentSourcesForKeyClaims": 3, "contradictionPass": false, "primarySourcePreference": true, "exhaustiveGapReview": false, "checkpointEveryRounds": 0 },
      "high": { "budgetCredits": 50, "maxRounds": 13, "minCooldownMs": 20000, "maxCooldownMs": 40000, "notebookCadenceRawBlocks": 10, "maxSearchesPerRound": 4, "maxFetchesPerRound": 2, "minIndependentSourcesForKeyClaims": 3, "contradictionPass": true, "primarySourcePreference": true, "exhaustiveGapReview": true, "checkpointEveryRounds": 4 },
      "ultra": { "budgetCredits": 100, "maxRounds": 30, "minCooldownMs": 60000, "maxCooldownMs": 120000, "notebookCadenceRawBlocks": 12, "maxSearchesPerRound": 5, "maxFetchesPerRound": 3, "minIndependentSourcesForKeyClaims": 4, "contradictionPass": true, "primarySourcePreference": true, "exhaustiveGapReview": true, "checkpointEveryRounds": 8 }
    }
  },
  "thinkingStripPatterns": "",
  "maxSources": 8,
  "deepIterations": 3
}
```

### `PUT /settings`

Update settings. Pass the full settings object (GET first, modify, PUT back).

**Request Body:** Same shape as GET response.

**Response (200):**

```json
{ "ok": true }
```

**Settings Schema v2** — The `version` field enables automatic migration. Old settings without the new fields are normalized with defaults.

**Settings sections:**

| Section | Description |
|---------|-------------|
| `providers` | Provider credentials and enabled state |
| `providerOrder` | Priority order for provider cycling |
| `modelRouting` | Task-specific model assignments (4 roles: title, reasoning, instant, deep) |
| `research` | Budget: `maxCreditsPerQuery`, `maxFollowUpQueries` |
| `api` | API behavior: concurrency, retention, limits |
| `serper` | Search API credentials |
| `general` | `maxSources`, `deepIterations`, `thinkingStripPatterns`, `notebookEnabled` |

---

## Conversations API

### `GET /conversations`

List all conversations.

**Response (200):**

```json
[
  { "id": "conv-uuid", "query": "What is AI?", "title": "AI Overview", "timestamp": "2026-06-16T01:00:00.000Z", "mode": "deep", "depth": "med" }
]
```

### `POST /conversations`

Create a new conversation. Triggers automatic title generation using the configured title model.

**Request Body:**

```json
{ "id": "conv-uuid", "query": "What is AI?", "mode": "deep", "depth": "high" }
```

- `mode` (optional): `quick` or `deep`. Defaults to `quick` when omitted.
- `depth` (optional): `low`, `med`, `high`, or `ultra`. Used when `mode` is `deep`; invalid values normalize to `med`.

**Response (200):** Updated conversation list.

### `PUT /conversations/:id/research`

Update persisted research mode/depth for a conversation (used on follow-up searches and mode changes).

**Request Body:**

```json
{ "mode": "deep", "depth": "ultra" }
```

**Response (200):** `{ "ok": true }`

### `GET /conversations/:id/messages`

Get all messages for a conversation.

**Response (200):**

```json
[
  { "type": "user", "content": "What is AI?" },
  { "type": "assistant", "content": "Artificial intelligence is...", "data": { "query": "...", "answer": "...", "sources": [...], "steps": [...] } }
]
```

### `PUT /conversations/:id/messages`

Save/update messages for a conversation.

**Request Body:**

```json
{ "messages": [...] }
```

### `PUT /conversations/:id/rename`

Rename a conversation.

**Request Body:**

```json
{ "title": "New Title" }
```

### `DELETE /conversations/:id`

Delete a conversation.

---

## Utility Endpoints

### `GET /health`

```json
{ "status": "ok" }
```

### `GET /config`

```json
{
  "keyCount": 1,
  "serperKeyCount": 1,
  "providerCount": 5
}
```

| Field | Description |
|-------|-------------|
| `keyCount` | Number of Groq API keys configured |
| `serperKeyCount` | Number of Serper API keys configured |
| `providerCount` | Number of enabled providers |

Exposed publicly (no auth) for the frontend to show configuration status.

### `GET /autocomplete?q=search+term`

Proxies Google Suggest autocomplete. Requires minimum 2 characters.

```json
{ "suggestions": ["search term meaning", "search term definition", ...] }
```

Maximum ${autocompleteCount} suggestions returned (default: 5).

### `GET /ping`

```json
{ "version": 2, "note": "new code running" }
```

### `POST /test-llm`

Test LLM provider connectivity. Sends a non-streaming request first; falls back to streaming if that fails.

**Request Body:**

```json
{ "messages": [{ "role": "user", "content": "Hello" }] }
```

**Optional query parameter:** `?label=test-name`

**Response:**

```json
{
  "ok": true,
  "mode": "non-streaming",
  "data": { "choices": [...] },
  "model": "llama-3.3-70b-versatile",
  "provider": "groq"
}
```

Or on streaming fallback:

```json
{
  "ok": true,
  "mode": "streaming",
  "fullContent": "Hello! How can I help you?",
  "model": "llama-3.3-70b-versatile",
  "provider": "groq"
}
```

On failure (both modes):

```json
{ "ok": false, "error": "...", "error2": "..." }
```

---

## Type Definitions

### `SearchResponse`

```typescript
interface SearchResponse {
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
  research_depth?: 'low' | 'med' | 'high' | 'ultra';
  research_notebook?: {
    id: string;
    path: string;
    updates: number;
    updatedAt: string;
  };
}
```

### `Source`

```typescript
interface Source {
  title: string | null;
  url: string;
  domain: string;
  snippet?: string | null;
}
```

### `AgentStep`

```typescript
interface AgentStep {
  type: string;       // "plan" | "search" | "analyze" | "synthesize" | "review"
  query?: string;
  result_count?: number;
  note?: string;
  model?: string;
  reasoning?: string;
  context?: string;
  duration_ms?: number;
}
```

### `ResearchJobRecord`

```typescript
interface ResearchJobRecord {
  id: string;
  query: string;
  history?: { role: string; content: string }[];
  mode: 'quick' | 'deep';
  depth?: 'low' | 'med' | 'high' | 'ultra';
  status: 'queued' | 'planning' | 'searching' | 'reviewing' | 'synthesizing' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: SearchResponse;
  error?: string;
  cancelled: boolean;
  steps: AgentStep[];
}
```

### `ResearchBatchRecord`

```typescript
interface ResearchBatchRecord {
  id: string;
  queries: string[];
  history?: { role: string; content: string }[];
  mode: 'quick' | 'deep';
  depth?: 'low' | 'med' | 'high' | 'ultra';
  maxConcurrent: number;
  sharedCredits: number;
  perItemCredits: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelled: boolean;
  items: ResearchBatchItem[];
  results: Array<SearchResponse | null>;
}
```

### `ResearchBatchItem`

```typescript
interface ResearchBatchItem {
  id: string;
  query: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: SearchResponse;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}
```

---

## Research Budget System

Every research query consumes **research credits**. The budget prevents runaway costs from excessive tool calls and search rounds.

### Credit Model

| Scope | Setting | Default | Description |
|-------|---------|---------|-------------|
| Per query (interactive search) | `research.maxCreditsPerQuery` | `20` | Max credits for a single `/search` call |
| Per job | `research.maxCreditsPerQuery` | `20` | Max credits for a research job |
| Per batch item | `perItemCredits` | `20` | Max credits per batch item |
| Batch shared pool | `sharedCredits` | `perItemCredits * items.length` | Total credits shared across all items |

### How Credits Are Consumed

- Each tool call (search) consumes 1 credit
- Each LLM call (analyze, synthesize, review) consumes 1 credit
- When budget is exhausted, the engine stops making new tool calls and proceeds directly to synthesis

### Budget Reporting

Completed search responses include `research_budget`:

```json
"research_budget": {
  "used": 5,
  "limit": 20,
  "exhausted": false
}
```

---

## Provider & Model Routing

### Supported Providers

| ID | Label | Default URL |
|----|-------|-------------|
| `groq` | Groq | `https://api.groq.com/openai/v1/chat/completions` |
| `gemini` | Gemini | `https://generativelanguage.googleapis.com/v1beta` |
| `vercel` | Vercel AI Gateway | (user-configured) |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1/chat/completions` |
| `custom` | Custom | (user-configured) |

Providers must be OpenAI-compatible (standard chat completions API format). **Exception:** Gemini uses its native REST API format (`/v1beta/models/{model}:generateContent`); the backend automatically converts between formats.

### Model Roles

The system assigns models to tasks through `modelRouting` (4 roles):

| Role | Used By | Purpose |
|------|---------|---------|
| `title` | `POST /conversations` | Conversation title generation |
| `reasoning` | Tool-calling rounds | Complex reasoning (reserved, currently uses `instant`/`deep` role) |
| `instant` | `mode: "quick"` | Quick research — tool-calling rounds, synthesize |
| `deep` | `mode: "deep"` | Deep research — planning, tool-calling, review, iterate, synthesize |

### Fallback Chain

Each role can have a fallback chain. If the primary provider/model returns a 4xx/5xx error, the system retries with the next fallback entry. If all entries fail, the system tries the next enabled provider in `providerOrder`.

### Provider Cycling

For each provider, the system round-robins through configured API keys and models. If a provider has 3 keys and 2 models, the effective combinations cycled are:
```
key[0]+model[0] → key[1]+model[0] → key[2]+model[0] → key[0]+model[1] → ...
```

---

## SSE Event Reference

### Event Types

| Event | Emitted By | Description |
|-------|-----------|-------------|
| `step` | `GET /research-jobs/:id/events`, `GET /research-batches/:id/events` | Agent step update (plan, search, analyze, synthesize, review) |
| `progress` | `GET /research-jobs/:id/events` | Live budget, depth, round, and notebook stats while job is running |
| `sources` | `GET /research-jobs/:id/events`, `GET /research-batches/:id/events` | Sources discovered during search |
| `context` | `GET /research-jobs/:id/events` | Full LLM conversation history (sent once before `done`) |
| `token` | `GET /research-jobs/:id/events`, `GET /research-batches/:id/events` | Streaming answer token |
| `done` | `GET /research-jobs/:id/events`, `GET /research-batches/:id/events` | Final result |
| `error` | `GET /research-jobs/:id/events`, `GET /research-batches/:id/events` | Error |
| `status` | `GET /research-jobs/:id/events`, `GET /research-batches/:id/events` | Status transition |
| `item` | `GET /research-batches/:id/events` | Per-item status update |

### SSE Wire Format

```
event: step
data: {"type":"step","data":{"type":"search","query":"...","result_count":5},"timestamp":"2026-06-16T01:00:00.000Z"}

event: token
data: {"type":"token","text":"partial answer","timestamp":"..."}

event: done
data: {"type":"done","response":{"query":"...","answer":"...","sources":[...]},"timestamp":"..."}

event: context
data: {"type":"context","finalContext":"...full LLM conversation history...","timestamp":"..."}

event: error
data: {"type":"error","message":"Provider unavailable","timestamp":"..."}

event: status
data: {"type":"status","status":"running","timestamp":"..."}

event: sources
data: {"type":"sources","sources":[{"title":"Source title","url":"https://...","domain":"example.com"}],"timestamp":"..."}
```

Events are separated by double newlines (`\n\n`). Each event line is prefixed with `event: ` and `data: `.

---

## Error Handling

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `202` | Accepted (job/batch created, processing async) |
| `400` | Bad request (missing required fields) |
| `404` | Resource not found (job/batch/conversation ID) |
| `500` | Internal server error (settings parse failure, etc.) |

### Error Response Format

```json
{ "detail": "Error message describing what went wrong" }
```

### Common Error Scenarios

| Scenario | Status | Message |
|----------|--------|---------|
| Missing query | `400` | `"Query is required"` |
| Empty queries array | `400` | `"queries array is required"` |
| Missing conversation id | `400` | `"id and query required"` |
| Missing rename title | `400` | `"title required"` |
| Job not found | `404` | `"Job not found"` |
| Batch not found | `404` | `"Batch not found"` |
| Settings parse error | `500` | `{ "detail": "..." }` |

---

## Rate Limits & Retention

### In-Memory Limits (configurable via settings `api.*`)

| Setting | Default | Description |
|---------|---------|-------------|
| `maxActiveJobs` | `50` | Max concurrent research jobs before oldest are pruned |
| `maxActiveBatches` | `50` | Max concurrent batches before oldest are pruned |
| `maxEventsPerJob` | `250` | Events retained per job (oldest dropped) |
| `maxEventsPerBatch` | `300` | Events retained per batch (oldest dropped) |
| `maxRetentionMinutes` | `1440` (24h) | Target retention period (currently count-based pruning, not time-based) |

### Pruning Behavior

When the limit is exceeded, the oldest entries (by `createdAt`) are removed until the count is within bounds. Pruning affects both the main record and its event subscriptions.

### Limitations

- Jobs and batches are **in-memory only** — they do not survive server restart
- There is no persistent database for job/batch history
- For production use, add a persistent store (Redis, SQLite, PostgreSQL, etc.)
