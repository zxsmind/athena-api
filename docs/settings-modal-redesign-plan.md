# Settings Modal Redesign Plan

## Goal

Make the settings modal easier to use by splitting the current single dense screen into focused tabs, then evolve settings into a versioned control surface for providers, model routing, advanced research behavior, and public API features.

## Current State

- Frontend modal: `src/components/SettingsModal.tsx`
- Modal context: `src/context/SettingsModal.tsx`
- API client: `src/lib/api.ts`
- Settings endpoint: `server/src/index.ts`
- Settings transform layer: `server/src/settings.ts`
- Settings store: `server/src/settings-store.ts`
- LLM provider/model selection: `server/src/llm.ts`
- Research engine: `server/src/engine.ts`
- Search settings usage: `server/src/search.ts`
- Persisted settings file: `backend/settings.json`

Current settings are flat:

- `providers`
- `serper`
- `general.maxSources`
- `general.deepIterations`
- `general.thinkingStripPatterns`
- `general.titleModel`

Provider/model selection is currently provider-list cycling, not task-specific model routing. Deep research currently runs inside the same SSE request and is not a long-running job with polling.

## Target Tabs

### General

General app/server behavior:

- Host and port
- Default behavior
- Title generation defaults
- Other app-wide settings that do not belong to a provider, model role, research budget, or API integration

### Providers

Provider connectivity and credentials:

- Enabled providers
- Provider priority/order
- Display name
- API base URL
- API keys
- OpenAI-compatible flag
- Provider-level capabilities

Provider keys should be masked in the UI rather than displayed in full.

### Models

Task-specific model routing:

- Title model
- Fast model
- Wide/context model
- Reasoning model
- Synthesis model
- Deep research model
- Fallback chain per role
- Per-role max tokens, temperature, streaming preference

Provider model lists should remain editable, but the actual model chosen for each task should be explicit.

### Advanced

Research and output controls:

- Max sources
- Thinking strip patterns
- Deep iterations
- Research budget per user query
- Max research credits per query, for example 20
- Follow-up query limit
- Max research rounds
- Search locale/options
- Source deduplication behavior

### API

External/custom API support:

- Custom API support
- OpenAI-compatible endpoint support
- Batch support
- Long-running deep research jobs
- Polling for jobs lasting from 1 minute to 10 hours or up to 3 days
- Job status reporting
- Cancellation
- Result retention

## Phased Implementation

### Phase 1: Tabbed Modal UI

Refactor `SettingsModal.tsx` into tabs using the existing settings payload. No new backend behavior yet.

Deliverables:

- Add `General`, `Providers`, `Models`, `Advanced`, and `API` tabs.
- Move existing provider settings into `Providers`.
- Move existing provider model lists and title model into `Models`.
- Move Serper, max sources, deep iterations, and thinking strip patterns into `Advanced`.
- Add read-only or preparatory sections for future API capabilities without persisting unsupported fields.
- Preserve current save/load behavior.
- Keep changes scoped to the modal.

### Phase 2: Settings Schema v2

Introduce a versioned settings schema with backward-compatible migration.

Suggested additions:

- `version`
- `providerOrder`
- `modelRoles`
- `research`
- `api`
- `advanced`

Migration must preserve existing `backend/settings.json`.

### Phase 3: Provider and Model Binding

Update `server/src/llm.ts` to select models by task role instead of simple provider/model cycling.

Suggested model roles:

- `title`
- `fast`
- `wide`
- `reasoning`
- `synthesis`
- `deepResearch`
- `fallback`

Each role should support a primary model and fallback chain.

### Phase 4: Advanced Research Controls

Connect advanced settings to `server/src/engine.ts` and `server/src/search.ts`.

Required behavior:

- Enforce max sources.
- Make deep iterations actually affect deep research rounds.
- Add per-query research credit budget.
- Enforce follow-up search limits.
- Report budget use in agent steps or job status.

### Phase 5: Long-Running Research API

Keep `/search` SSE for short interactive requests and add job-based research endpoints.

Suggested endpoints:

- `POST /research-jobs`
- `GET /research-jobs/:id`
- `GET /research-jobs/:id/events`
- `POST /research-jobs/:id/cancel`

Suggested job states:

- `queued`
- `planning`
- `searching`
- `reviewing`
- `synthesizing`
- `completed`
- `failed`
- `cancelled`

### Phase 6: Batch API

Add batch research support:

- Submit multiple queries.
- Limit concurrency.
- Apply shared and per-item budgets.
- Poll batch and item status.
- Return partial results safely.

### Phase 7: Validation and Tests

Add coverage for:

- Settings migration.
- Settings validation.
- Provider order.
- Model role fallback.
- Research budget enforcement.
- Long-running job polling.
- Batch lifecycle.

Before completing each implementation phase, run frontend and server builds.
