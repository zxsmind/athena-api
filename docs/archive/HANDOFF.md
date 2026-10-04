# Athena 002 handoff — 2026-09-30

**Status:** migration and production-hardening work is active. This is an evidence-based snapshot, not a completion claim.

## User-directed target

Athena is a self-hosted research API, not a chat product. The website is a playground for the API. Search and Contents are model-free retrieval primitives. Research is an asynchronous, auditable job that produces a structured evidence report.

Retired 002's Instant/Quick versus Deep control in favour of the 001 research contract:

| Research mode | Intended behavior | Default budget profile |
|---|---|---|
| `standard` | One researcher pass | `standard` |
| `deep` | Plan, parallel research angles, and evidence-gap follow-ups | `thorough` |
| `deep-max` | Deep research plus a separate claim-audit pass and rejected-claim details | `exhaustive` |

`budget_profile` (`lean`, `standard`, `thorough`, `exhaustive`) is a code-enforced resource ceiling. `reasoning_effort` (`low`, `medium`, `xhigh`) is sent to the model independently and defaults to `xhigh`. Search and Contents use neither control.

## Athena 001 findings

The 001 reference was read without changing it. Its design and code establish these useful contracts:

- Hexagonal dependency direction: domain concepts are model/vendor-free; application owns research orchestration; ports define external capabilities; adapters translate provider protocols; HTTP, CLI, MCP, and the dashboard are interfaces.
- Search and Contents stay separate from model calls. The same retrieval application path is intended for direct Search and research tools.
- Research jobs return `athena-research-report/v1`: structured findings with job-local `citation_ids`, a source registry, and explicit gaps. The model does not choose citation URLs or return a chat-style Markdown answer.
- The evidence graph records claims, sources, provenance, support, and contradiction. It makes gaps visible; it is not an automatic truth oracle.
- The model owns research judgement. Code validates outputs and enforces resource ceilings; hitting a ceiling is a visible terminal result with partial work and spend.
- Jobs use sequenced SQLite events and SSE cursor replay. 001's own handoff still lists crash resume and cooperative cancellation as incomplete.
- Evaluation is part of the architecture: deterministic provenance/ceiling/event checks, retrieval diagnostics, rubric-based answer evaluation, then external benchmarks. A quality claim needs a measured baseline.
- The accepted provider direction is AI SDK for model transport and models.dev for provider/model/capability data. ADR 0016 describes a catalog-driven registry, package/version checks, and behavioral capability probes. 001's actual implementation is narrower: one OpenAI-compatible model adapter and a small hard-coded catalog. The ADR is a target contract, not proof that arbitrary providers already work.
- Search adapters present in 001 source are You.com and SearXNG. They are invoked by an explicit retrieval request; startup does not issue search probes. Provider breadth in ADR 0007 is broader than the adapters actually shipped.
- `visual`/`visual-max`, WebSocket, Effect, crash resume, temporal windowing, and complete architecture/eval gates are deferred or incomplete in 001's own handoff/roadmap. They must not be described as already implemented.

## 002 current state versus target

| Area | 002 evidence at handoff | Required migration |
|---|---|---|
| Research modes | `/v1/research` accepts `standard`, `deep`, `deep-max` with per-mode budget defaults and `reasoning_effort` `low/medium/xhigh` (default `xhigh`) plus `verbosity`. Legacy `Chat`/`Landing`/`SearchInput`/`ModeDropdown` UI files removed; App routes Playground only. | Done (item 1). Remaining: structured report path (item 2) still emits a natural-language `answer` string. |
| Research execution | `server/src/engine.ts` is a single tool-calling loop with notebook/checkpoint behavior. V1 emits a natural-language `answer` string and regex-cleans inline `[N]` citations. | Adopt 001's planner → worker(s) → evidence/claim assembly → sufficiency follow-up → optional deep-max verifier → structured report path. Retain useful 002 Smart Routing, notebook, and checkpoint behavior behind clear owners. |
| Evidence contract | V1 source indices resolve to a per-job source list; the model still authors report prose. | Done: server-owned `ev_NNN` evidence IDs, deterministic validation, unsupported claims become gaps, `deep-max` audit with rejected list (`server/src/engine/report.ts`). |
| Model providers | AI SDK is used, but 002's provider IDs/settings are statically enumerated. models.dev is an on-demand catalog/cache; it does not discover and activate arbitrary provider packages. | Reconcile provider settings with models.dev's provider/package/capability records and the installed AI SDK provider packages. Fail closed with a typed unsupported-capability/configuration error. |
| Search providers | `server/src/search.ts` calls Serper directly. Search is explicit, and missing configuration now produces `503 SEARCH_NOT_CONFIGURED`. | Keep no-startup-query behavior. Move retrieval behind a provider contract; add only providers that can be configured, operated, and measured in this deployment. |
| Persistence | 002 has shared SQLite storage for conversations, client-key hashes, request analytics, job snapshots/events, and batch snapshots/events. Checkpointed deep jobs can return paused after restart. | Keep SQL as the authority. Define durable event/job transitions and migrations; do not imply full crash resume or cooperative cancellation until proven. |
| Secrets | Provider and Serper credentials are in `ATHENA_DATA_DIR/settings.json` as plaintext. API responses mask key values, which is not encryption. | Move runtime secrets to environment/secret mounts or implement authenticated encryption with an externally managed key and a safe migration path. Never copy 001 `.env` or expose secret values. |
| Dashboard | 002 currently runs a Vite/React playground only; root `npm run dev` is configured to start UI and API together. 001 contains a Next.js dashboard with Home, Web Search, Contents, Deep Research, API Keys, Analytics, and Docs. | Keep only playground/product surfaces. Decide the final Next.js/Vite cutover from actual runtime and deployment constraints; do not reintroduce chat. The user favors 001's product shape. |
| Evaluation | 002 has an evaluation plan and ordinary unit tests, but no 001-style measured research baseline was established in this migration. | Port the deterministic and retrieval tiers first. Keep provider/model evaluations opt-in because they can incur external cost. |
| Operations | Root Dockerfile/Compose and Linux data paths exist. | Docker image and Compose operation have not been verified in this environment; production readiness is not established by compilation. |

## Work completed before this handoff

- The previous migration turn added `/v1` Search, Contents, asynchronous Research/jobs/SSE, API keys, analytics, models.dev metadata, SQL persistence, AI SDK calls, Docker/Compose files, and a Playground-only web route. Those changes are present as uncommitted work in 002 and must be preserved.
- The reported local 502 was traced to Vite running without the API on port 3001. The root development command was changed to start the API and UI together; the server watcher excludes generated Smart Routing build output.
- Missing Serper configuration now returns `503 SEARCH_NOT_CONFIGURED` with `retryable: false`; Research fails before creating a job when Search is unconfigured.
- Provider settings still store secret values as plaintext JSON. No encryption has been implemented yet.

## Verification evidence

- Frontend production build and backend TypeScript build passed after the preceding changes.
- At this handoff, `GET http://127.0.0.1:3001/v1/health` and the Vite proxy `GET http://localhost:5174/api/v1/health` both return `200`.
- Contents extracted one public HTML page successfully through the proxy.
- With no Serper key in the checked 002 configuration, Search and Research both return `503 SEARCH_NOT_CONFIGURED`. No Serper/model request was sent in this handoff.
- Docker CLI is unavailable in this environment, so Docker/Compose image execution has not been verified. Test suites were not run in this migration turn.
- The 001 `.env`, database, logs, and secret values were not opened or copied. The 001 directory has no Git metadata. 002 already contains uncommitted changes; nothing was committed or pushed.

## Ordered remaining work

0. ~~Rename the page-extraction feature from Fetch to Contents everywhere.~~ Done 2026-09-30: endpoint `POST /v1/contents` (no `/v1/fetch` alias), client `apiContents`, server `searchResults()` / `extractPageContent()`, search result field `extract_error`, Playground area/label/CSS, and all canonical docs. The model-facing `fetch_url` tool name is unchanged; it is an agent tool, not a public endpoint.
1. ~~Migrate the public API types, job records, checkpoints, batch compatibility, playground controls, and docs to `standard`/`deep`/`deep-max`, `budget_profile`, and `reasoning_effort`; retire the old Instant/Quick UI.~~ Done 2026-09-30: v1 accepts `standard/deep/deep-max` + `verbosity`; reasoning `low/medium/xhigh` default `xhigh`; engine/settings/jobs/batches/checkpoints/playground/docs migrated; legacy chat UI files deleted; no `quick`/`instant` mode, no `effort` alias, and no `researchDepths.defaultDepth` remain. Contract regression tests live in `server/tests/depth-presets.test.ts` ("research contract").
2. ~~Replace the v1 answer-string flow with the 001 structured researcher/report contract and deterministic evidence-ID validation. Deep Max must produce an independent audit and a rejected list.~~ Partially done 2026-09-30: `server/src/engine/report.ts` (deterministic registry, claim validation, `athena-research-report/v1` envelope) and `server/src/engine/report-llm.ts` (claim extraction, `deep-max` audit, deterministic `[N]` fallback) are implemented and unit-tested; `/v1/research` returns `result.report` and the playground renders sections, gaps, and the audit block. **Still open:** the 001 planner → worker(s) → sufficiency loop is not adopted; `engine.ts` is still one agentic tool-calling loop.
3. Move research ownership out of the monolithic engine into cohesive domain/application/provider boundaries, keeping Smart Routing and 002's useful persistence/checkpoint capabilities. Partially started 2026-09-30: `engine/sources.ts`, `engine/context-blocks.ts`, `engine/compaction.ts`, `engine/report.ts`, and `engine/report-llm.ts` now own those concerns with tests, and `noUnusedLocals`/`noUnusedParameters` are enabled in `server/tsconfig.json`. `engine.ts` is still one agentic tool-calling round function; the 001 planner/worker/sufficiency split is not adopted.
4. Replace the manually enumerated model/provider assumptions with a catalog-driven AI SDK registry, including capability validation and explicit provider configuration errors.
5. Resolve secret handling before production claims; define migration and key-rotation behavior before changing any existing credential store.
6. Reconcile 001's temporal, event, cancellation/resume, provider resilience, and evaluation designs against 002's current implementation. Implement and measure the concrete requirements; retain visual/WebSocket/other deferred features only with explicit dependency and acceptance gates.
7. Transfer and reconcile 001's architecture, domain, API, researcher, eval, roadmap, handoff, and all 17 ADRs into 002's canonical documentation. Mark implementation status accurately and retire contradictory legacy plans.
8. Validate offline contracts/builds first; then perform provider-backed Search/Research and Docker/Linux runtime checks only when credentials and the runtime are configured. Never treat source/build success as a live provider or production proof.

## Safety and continuity

- Keep all work in `C:\Users\zxsmi\Desktop\athena-002`; treat 001 as read-only reference unless the user asks otherwise.
- Preserve existing data, uncommitted work, and credentials. Do not read or copy `.env`, settings secrets, or database contents as part of migration.
- Do not issue provider requests during startup. Do not commit or push without an explicit request.
- Update this handoff and the relevant canonical docs as implementation progresses; this snapshot must be replaced when status changes.
