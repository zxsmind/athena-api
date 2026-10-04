# Athena roadmap

This roadmap tracks the move from a chat-centered app to a research API while retaining the useful 002 product features.

## Phase A — API foundation (implemented in source)

- Separate model-free `POST /v1/search` and `POST /v1/contents` from model-driven `POST /v1/research`.
- Add query count/type/location/freshness/domain/depth controls and readable HTML/PDF extraction.
- Return asynchronous research jobs, snapshots, replayable SSE, cancellation, pause, and resume.
- Keep model-written inline `[N]` citations and resolve every link through the per-job source registry.
- Expose independent `budget_profile` and `reasoning_effort` controls.
- Route model calls through AI SDK and capability metadata; preserve Smart Routing and the Google AI SDK provider.
- Add hashed client keys, request analytics, and an on-demand models.dev catalog.
- Add a compact API Playground over the existing React 19/Vite 8 app.
- Consolidate architecture, researcher, evaluation, and handoff documentation.

## Phase B — Verification before a production claim

- Run focused TypeScript builds and existing tests; add v1 contract tests when explicitly authorized.
- Exercise Search, Contents, Research, key lifecycle, SSE replay, and citation cleanup against configured providers.
- Capture a browser view of the playground and confirm citations resolve to the displayed source cards.
- Reconcile npm advisories surfaced by the AI SDK dependency update.

## Phase C — Operational hardening

- Add bounded retention/backup for SQLite and the `/data` volume.
- Add API quotas and per-key rate limits before exposing the listener beyond a trusted network.
- Expand restart recovery for jobs that have no deep checkpoint while keeping startup free of automatic provider calls.
- Add a second search provider only when fallback behavior and retrieval quality can be measured.

## Explicitly deferred

An owned web index, visual/browser research, billing/teams/SSO, distributed queues, and a complete conversion of the legacy chat frontend are outside this API migration. Existing mobile, batch, notebook, and deployment code remain intact.
