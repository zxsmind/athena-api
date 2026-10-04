# Code-execution research harness (plan)

**Status:** P0 measured and passed; P1 built and gated (2026-10-02). Decisions
D1–D6 are recorded at the end. P2–P4 are not built. This document plans a
change to the research engine. It is not a description of the current system —
[ARCHITECTURE.md](ARCHITECTURE.md) owns that.

## Why this plan exists

The current engine is a naive agent loop: the model calls `web_search` or
`fetch_url`, the full result enters the conversation, and it stays there. Three
measured consequences:

1. **Depth is decided by the model, and the prompt licenses a cheap stop.** In a
   `deep` run the ceilings allow 60 steps and 120+120 calls; measured runs stop
   at 8–19 calls (`j-aRnUxmgzu8Sz`, `j-jeUkz2zstKHc`). The budget is never the
   binding limit; the "Stop when…" rule is.
2. **Raw data churns through the context.** A 61-step dogfood run fetched 40
   pages, then called `recall_source` 20 times to re-read cleared sources and
   triggered 15 recall-clear passes (`j-M74E5cbkQtjl`). Raw text moves from the
   conversation to the evidence store and back, paying tokens in both
   directions.
3. **Search snippets are already citation-ready**, so fetching looks optional.
   One search call returned 30,759 characters for 29 results; the prompt itself
   says to fetch only "when the wording or the number matters".

External evidence for the alternative:

- Parallel's Task API harness gives the orchestrating model a **sandboxed
  interpreter** and turns `search`/`extract` into ordinary functions. Only the
  code block's return value re-enters the context; interpreter variables are a
  persistent working memory. A 20-step task that fills 128K tokens under tool
  calling stays under 30K tokens. Stopping is **budget-driven**, not semantic:
  the harness tracks cumulative cost and asks for synthesis as the budget
  depletes. They explicitly reject the naive loop because "the model ends up
  spending too much capacity re-reading intermediate results".
- Anthropic's multi-agent research system reports that **token usage alone
  explains 80% of BrowseComp performance variance**; multi-agent runs spend
  roughly 15x chat tokens. Subagents read in their own contexts and return
  condensed findings, so the lead never reads raw pages.

The goal is not to copy either system. It is to make depth cheap: keep raw data
out of the model's context so spending more budget buys more research instead of
more re-reading.

## Non-goals

- Building a proprietary web index or extraction service. Parallel's index is
  not required for the behavior; the retrieval stack we have is the input.
- Changing the `/v1/search` and `/v1/contents` boundary (ADR 0001): retrieval
  stays model-free and independently measurable.
- Mixing the architectures in one loop. The code engine replaces the retrieval
  tools for its jobs; the classic engine never sees `run_code`. The flag selects
  an engine, not a tool list (D7). Measured: offered beside the classic tools,
  `run_code` was called zero times in two live runs.
- Raising quality claims without fixed-suite evidence (ADR 0007).

## Target architecture

Two engines on a shared spine. `agenticResearchStream` is the entry point and
selector; budget counters, modes, checkpointing, tracing, the evidence store,
the model transport, search/extract functions and the v1 report are shared.
The loops and prompts are not.

```
sandbox.enabled?
  no  ──▶ engine.ts          classic loop
           web_search / fetch_url tools, classic prompt
  yes ──▶ code-engine.ts     code loop
           run_code is the only tool, code-native prompt
             │
             ▼
           sandbox (one per job, persistent state)
             │  search() / extract() / read_source()
             ▼
           engine handlers (engine/sandbox-handlers.ts):
             searchResults / extractPageContent / recallSource
             evidence store, [Source #N] assignment
             budget charge, trace events
```

- One tool on the code path: `run_code`. The model submits a program; the
  sandbox returns the program's return value (and stdout, clipped). Only that
  enters the conversation.
- One sandbox per job, kept alive across rounds so variables persist.
- Every capability the program can reach is an injected function that the
  engine implements and meters. The sandbox itself has no network, filesystem,
  or environment access.
- Source numbering stays engine-assigned at retrieval time, exactly as today.
  Injected results carry `[Source #N]` so the final answer's citations still
  resolve through `sanitizeResearchAnswer`.

## How the injected functions are written

Three pieces, one small file each:

1. **Engine handlers.** `search` maps to `searchResults`, `extract` to
   `extractPageContent` plus chunk selection, `read_source` to the evidence
   store. These exist today; the handlers add budget charging, source
   numbering, and trace events.
2. **Sandbox harness.** One small file per backend that defines the function
   names in the sandbox language and bridges each call to the engine:
   - Deno: a harness module reads JSON-RPC requests on stdin and writes
     responses to stdout. Functions are async wrappers around one
     `callEngine()` helper.
   - Pyodide: a Python prelude that wraps JS-bridged async functions; the
     functions are injected once with `pyodide.globals.set`, and `await`
     works inside `runPythonAsync`.
   - Docker: an HTTP server inside the container exposing the same JSON-RPC
     contract; the harness is the same as the Python or Node one.
3. **Wire contract.** A versioned request/response schema
   (`harness_api: 1`) shared by all backends. One request per injected call:
   `{id, fn, args}`; one compact JSON response; errors are text the model can
   read and recover from.

Surface for the model, version 1:

```text
await search({queries})                  -> [{n, title, url, snippet}]
await extract({urls, question?, max_chars?}) -> [{n, title, url, excerpts: [{text}]}]
await read_source({n, offset?, limit?})    -> {text}
state                                       -> free-form object, persists per job
```

`extract` with a `question` is the targeted reader: the engine selects the
chunks that answer the question (keyword scoring first; an embedding step or a
small model only if measurement demands it) and returns excerpts with quotes.
Without a `question` it returns the page clipped to `max_chars`. (An
`objective` parameter was specified here once and removed before P2 shipped:
it was documented in the prompt but ignored by the engine, and no pipeline
stage could use it. If intent-tracking returns, it returns with a reader.)

## Sandbox backends

| Backend | Language | Isolation | State persistence | Dev cost | Ops cost |
|---|---|---|---|---|---|
| Deno subprocess | JS/TS | Process, no permissions, no net/fs/env | Explicit `state` object; `globalThis` | Low (single binary) | Low |
| Pyodide (WASM) | Python | WASM, no OS by construction | True globals across `runPythonAsync` | Medium (≈20–30 MB asset, local `indexURL`) | Low |
| Docker container | any | Strongest (cgroups, seccomp) | Per-container | High (image, socket, orchestration) | High (Docker on host) |
| `node:vm` + worker (rejected) | JS | Not adversarial-grade | Partial | Low | Low |

Deno and Pyodide were the two candidates for the spike, and both passed.
Python is the stronger language for the parsing and aggregation the harness
exists to enable, so P1 ships the Pyodide backend (D2); the measured Deno
harness is parked, not deleted. Docker is the hardening path once the behavior
is proven, not a prerequisite.

## Engine integration

| Area | Change | File |
|---|---|---|
| Engine selection | `sandbox.enabled` chooses the code engine; the classic loop never sees `run_code` (D7) | `server/src/engine.ts` |
| Code loop | `run_code` is the only tool; budget, checkpoints, trace, v1 report | new `server/src/code-engine.ts` |
| Code prompt | Code-native system prompt; shares no text with the classic body | new `server/src/agent/code-prompt.ts` |
| Tool schema | `RUN_CODE_TOOL` with `code` + optional `label` | `server/src/engine/types.ts` |
| Tool handling | Execute in the job's sandbox; clip output; restart on crash | `server/src/code-engine.ts` |
| Sandbox module | Backend interface, Pyodide implementation (Deno parked), RPC, harness file | new `server/src/sandbox/` |
| Engine handlers | `search`/`extract`/`read_source` over RPC, shared meters and registry | new `server/src/engine/sandbox-handlers.ts` |
| Shared report | v1 report builder, imported by both engines | new `server/src/engine/report-run.ts` |
| Config | `sandbox: { enabled, backend, timeoutMs, maxOutputChars, maxConcurrent }`, closed schema, default `enabled: false` | `server/src/config/schema.ts`, `defaults.ts` |
| Trace | `code.result` (clipped), `engine: 'code'` on run start/end | `server/src/trace.ts` |
| Budget | Each injected call charges the same meters as the equivalent classic call | `server/src/engine/sandbox-handlers.ts` |
| Timeouts | Per-execution cap (default 60 s); activity-aware LLM timeout is a separate prerequisite fix (P3) | `server/src/sandbox/pyodide-session.ts` |
| Evidence | Injected results store evidence and keep `[Source #N]` | `server/src/engine/evidence-store.ts` |

## Phases and gates

**P0 — spike (0.5–1 day).** Throwaway scripts under `server/spike/` (not wired
into the engine): run the same three fixed queries through Deno and Pyodide
with `search`/`extract` injected, persistent state, output clipping. Measure:
programs that run without a syntax/runtime error; LLM rounds; tokens entering
the model per round; sources gathered; cost. **Gate:** at least one backend
shows working programs on the first attempt for ≥2 of 3 queries and lower
tokens-per-round than the current engine on the same query. If neither does,
stop and report why (model, harness, or extraction).

**P1 — the code engine (built 2026-10-02).** The second engine behind
`sandbox.enabled`, default off: execution timeout, output cap, restart policy,
trace events, budget charging through shared handlers, `state` checkpointing
(D4), sandbox concurrency cap with queue (D5), and its own code-native prompt.
The classic loop is unchanged and code-free. **Gate:** full test suite green;
one live run better than the classic baseline's tokens per round — met
(9,724 vs 30,540), and the first attempt's hybrid tool list was removed by D7
after measuring zero `run_code` calls in two live runs.

**P2 — compact retrieval API (2–4 days).** Target `extract`, compact `search`,
`read_source`, source numbering through RPC, `Promise.all`/`gather`
parallelism inside one execution, and the CPU-seconds meter with its plan and
billing updates (D6). **Gate:** on the fixed suite, fewer LLM
rounds and lower tokens-per-round than the captured baseline with no citation
regressions.

**P3 — budget semantics and resilience (2–3 days).** Replace the semantic stop
rules with budget-driven synthesis (warn at a threshold, reserve a synthesis
allowance, degrade to a partial answer instead of failing the run). Fix the
activity-aware timeout and the mislabelled `no enabled keys` error while here.
**Gate:** a long run reaches synthesis without dying; cache invalidation from
offload measured, not assumed.

**P4 — evidence binding and source quality (later).** Require quotes for cited
claims (Basis-like), extend the citation validator, add source-quality
heuristics. Only after P2–P3 pass.

Each phase ends with the four gates from AGENTS.md (`tsc`, tests, build, lint)
and the matching doc updates: PROMPTS.md for prompt changes, ARCHITECTURE.md
and AGENTS.md when the architecture changes.

## P0 results (2026-10-02)

Harness under `server/spike/` (throwaway, not wired into the engine): the model
writes one program per round against injected async `search`/`extract`/
`read_source` over the real retrieval functions; stdout and the return value
are clipped (2,000/4,000 chars) and fed back. Three fixed queries (Parallel
architecture, agent architectures, immortal snail) × Deno and Pyodide, 8 rounds
each. Raw reports, transcripts, and answers in `%TEMP%\opencode\spike\`.

| Run | Programs ok | Rounds | Sources | Extracted | Fresh in | Cache read | In/round | Cost |
|---|---|---|---|---|---|---|---|---|
| Deno q3 | 8/8 | 8 | 28 | 6 | 21,977 | 9,600 | 3,947 | $0.0162 |
| Deno q4 | 6/8 | 8 | 40 | 6 | 15,506 | 0 | 1,938 | $0.0129 |
| Deno snail | 5/8 | 8 | 32 | 1 | 20,887 | 11,200 | 4,011 | $0.0161 |
| Pyodide q3 | 8/8 | 8 | 25 | 2 | 16,040 | 3,200 | 2,405 | $0.0110 |
| Pyodide q4 | 8/8 | 8 | 77 | 1 | 15,542 | 0 | 1,943 | $0.0116 |
| Pyodide snail | 7/8 | 8 | 46 | 2 | 14,814 | 0 | 1,852 | $0.0113 |

**Gate verdict:** passed by both backends. Every query ran a working program on
the first attempt (3/3 each), and tokens entering the model per round are
1,852–4,011 against 28,147 (Parallel query) and 30,540 (snail) measured on the
classic engine trace — 7–15x lower. Pyodide is confirmed as the default (D2);
Deno remains viable and is parked, not shipped.

What the runs also showed:

1. **Code execution alone does not converge.** None of the six runs reached
   synthesis inside 8 rounds; the model kept researching. This confirms the
   plan's P3: the stop decision is an engine budget decision, not a prompt
   rule. Parallel publishes the same conclusion ("injects budget warnings when
   remaining spend drops below a threshold").
2. **The model pages through sources instead of analysing them.** Repeatedly it
   printed `text[6000:11021]`, then `text[3900:6000]`, then `text[1500:3900]`
   from the same variable; each print came back clipped at 2,000 chars, so it
   kept slicing. The harness needs a read-window contract (`read_source`
   offset/limit) and a print budget the model can see, not an invisible clip.
3. **Extraction is rare.** 1–6 pages fetched against 25–77 sources seen; most
   claims would rest on snippets. Targeted `extract({question})` is the P2 fix,
   not a prompt sentence.
4. **Prompt caching is intermittent in this loop** (appeared in 3 of 12 runs,
   always late). Not enough to conclude; P3 measures cache behaviour rather
   than assuming append-only stability.
5. **Pyodide isolation:** with `fetch`/`WebSocket`/`XMLHttpRequest` deleted
   before load, Python cannot import or call them; the host filesystem is not
   mounted into the VFS. `js.process` is still reachable from the Node host and
   is a P1 hardening item (separate process, or accept and document).
6. **Program reliability:** Deno 19/24 programs ran, Pyodide 23/24 (errors were
   ordinary model bugs — undefined variables, wrong key — and returned as text).
   The reported code strength of `qwen3.8-27b` held up at this sample size.

## P1 results (2026-10-02)

Built as a second engine (D7), not a mode of the classic loop:

- `server/src/code-engine.ts` — the code loop: `run_code` is the only tool, its
  own code-native prompt (`agent/code-prompt.ts`), same budget counters,
  checkpointing, tracing and v1 report.
- `server/src/sandbox/` — types, Pyodide session, host, manager (concurrency cap
  and queue). Shared with nothing classic.
- `server/src/engine/sandbox-handlers.ts` — `search`/`extract`/`read_source`
  answered over RPC, charging the same meters and sharing the source registry.
- `server/src/engine/report-run.ts` — the v1 report, shared by both engines.
- Config block `sandbox {enabled, backend, timeoutMs, maxOutputChars,
  maxConcurrent}`, closed schema, default off. `agenticResearchStream` (the
  public entry) selects the engine from `sandbox.enabled`; the classic loop is
  untouched by code execution.

Four gates pass: `tsc`, 520 tests (including four that drive a real Pyodide
process: RPC injection, persistent globals, state export/hydrate, network
isolation, timeout kill and state replay), build, and lint.

Live gate (snail query, `deep`/`long`, sandbox enabled, code engine selected):

| Run | Rounds | `run_code` calls | Sources | Avg input/round | Cache hit | Answer | Wall |
|---|---|---|---|---|---|---|---|
| `j-WwZfGBXRSH0o` | 19 | 27 | 40 | 9,724 | 68% | 5,698 chars | 85 s |

Against the classic baseline on the same query (8 rounds, 30,540 input
tokens/round): 3x fewer tokens per round, a complete run, and the model called
`run_code` on every research round. For comparison, the same feature offered
beside the classic tools (the hybrid that briefly existed) measured **zero**
`run_code` calls in two live runs — which is why D7 splits the engines rather
than sharing a tool list.

Two defects were found and fixed while testing: an old host process exiting
after a timeout could clear its replacement (stale-exit race), and the
replacement must replay the last exported `state`, not only an explicit
`hydrate` call. One behavioural regression is visible in the live answer: it
opened with a title heading plus an answer label despite the prompt's opening
rule — the same stochastic rule-following the classic engine exhibits; the
shared `sanitizeResearchAnswer` now strips that chrome deterministically.

Two decisions were taken after the live gate:

- **The verification pass is retired (2026-10-03).** Three live code runs fired
  it zero times: it only ran on voluntary answers, and every measured run
  ended forced at a ceiling. Per its own condition above, a check that cannot
  fire is deleted rather than kept for principle. The fetched-vs-snippet
  distinction it checked now lives in the plan-evidence and floor machinery
  both engines share.
- **A zero-source answer is not refused.** A measured run (`j-sh5IvAdddogU`)
  answered a research question from model memory before any tool call. A
  refusal gate was drafted and removed on review: it would force research on a
  non-research input and treats a model choice as an engine precondition. The
  fixed suite measures the rate before any mechanism is built; the caller can
  already see `sources: []`.

### First-move measurement

Five English deep queries were run on the code engine before and after one
prompt rule was added: "The first program searches" (see PROMPTS.md section 5).
Same model, same mode, same queries in both sets. The classic engine ran the
first query as a control (`j-AGN3ijTcGHPE`): 7 rounds, 6 tool calls, 82
sources, 113K billable tokens.

| Set | Researching | Zero-tool answers | Programs (max) | Searches (max) | Pages read (max) | Sources (max) | Billable tokens (max) | Cache |
|---|---|---|---|---|---|---|---|---|
| before | 0/5 | 5/5 | 0 | 0 | 0 | 0 | ~10K | n/a |
| after | 3/5 | 2/5 | 60 | 47 | 33 | 198 | 197K | 79–85% |

The rule moved tool adoption from 0/5 to 3/5 and is kept. It is not
sufficient: two of five runs still answered from memory in round 0. The
researching runs are far deeper than anything measured before — 30–60
programs, 32–47 searches, 14–33 pages read, up to 198 sources, 1.1–1.3M raw
tokens with 79–85% served from cache.

Three failure modes appeared in the researching runs, none of them a prompt
problem:

- An empty completion at round 31 killed a 31-round run. The trace shows the
  root cause: one output token, `<|im_end|>` leaked into the reasoning channel
  with `finish_reason: stop` — the provider surfaced the Qwen end-of-turn
  token as text, nothing was dropped on our side. Both engines now retry the
  same round once on a degenerate completion (`j-ECmX3PY8KZyG`).
- At the step ceiling the forced-answer call timed out six times and the run
  errored, reported as "no enabled keys" although every attempt logged a
  timeout. Both were fixed in `llm.ts`: the per-call timeout now grows with
  the conversation (60s base plus 1s per 25K characters, capped at a further
  60s) so the largest prompt of the run is not the one with the shortest
  ceiling, and a `withRetry` exhaustion reports its actual error instead of a
  missing-key label (`j-faE5hOH46vGt`, `j-mRe99qbCJUfv`).
- The one completed run stopped itself at 40 of 60 allowed rounds and 33 of
  120 allowed page reads, below its ceilings (`j-IQAbWKoEvEpl`).

The next lever was then found in the provider's prompt cache. On
byte-identical requests the code engine flipped from `run_code` (cold) to an
answer from model memory (cached): every cold first turn called the tool and
every cached first turn did not, while classic requests stayed healthy under
the same cache (`j-oZFmiZxv9H0V`, cached=1600, `create_plan`) and later rounds
stayed healthy when cached (hundreds of observations, cache up to 6,400
tokens). The mechanism is provider-side and not proven; the flip on identical
bytes is measured, including by replaying the captured request body outside
the engine.

The engine therefore marks the first request with a per-job marker
(`<!-- request <jobId> -->`) so that turn is always cold; the marker
disappears from round 1 onward, where cached serving is measured safe. The
alternative, a forced `toolChoice` on round 0, would condition every request
including a greeting and was not chosen.

## P2 results (2026-10-03)

Built: batched question-targeted `extract` (keyword excerpts, 4 pages/call),
compact capped `search` (200-char snippets, 12 queries/call), `asyncio.gather`
parallelism proven over live RPC, and the CPU-seconds meter billed through the
shared charge path. Also fixed while here: the code engine never published
progress, so code runs were never billed — `onProgress` now flows like the
classic loop.

Fixed suite, battery query, `default`, same model (bunny varies run to run,
so n=3 against one P1 baseline):

| Run | Programs | Search / fetch | Billable tokens | Markers | Findings | Wall |
|---|---|---|---|---|---|---|
| P1 baseline `j-usofeD3V5FcD` | 11 | 40 / 13 | 42K | 20 | 14/14 + 12 gaps | ~380 s |
| P2 `j-x4dxOnB12kjX` | 11 | 40 / 21 | 60K | 18 | 10/10 + 17 gaps | ~254 s |
| P2 `j-oiLwwNwQw44T` | 6 | 40 / 4 | 37K | 9 | 8/8 + 18 gaps | ~210 s |

Targeted `extract({question})` was used from the first P2 program, with the
model choosing its own `max_chars`. CPU time billed (52s and 37s runs).

Gate verdict: **not met.** Rounds are level, tokens are not consistently
lower, citations drift down run to run. The pattern underneath matters more
than the gate: all three code runs burn searches to the ceiling (40/40) while
classic runs on the same query stop at 6-20. The code loop has no search
discipline — no per-need budgeting, no partial retirement — so breadth is
capped by ceiling rather than judged. That is the next work, not more
retrieval tuning.

## Impact beyond the engine

The measured problem lives in the engine, but six other subsystems are touched.
None needs a contract change for P0/P1; each row names what changes and when.

| Subsystem | Change | When |
|---|---|---|
| Job lifecycle (`research-jobs.ts`, `research-runner.ts`) | One sandbox per job: created on the first `run_code`, terminated on done, failed, or cancelled. The checkpoint carries the model's explicit JSON `state`; interpreter globals outside `state` are not serializable and are lost on resume, while page data stays recoverable from the evidence store via `read_source`. | P1 |
| Concurrency | `storage.maxActiveJobs` (50) times one interpreter each is a memory budget problem. Sandboxes are created lazily so classic runs never pay for them, and a configurable concurrency cap with queueing bounds the total (D5). | P1 |
| Metering / billing (`engine/metering.ts`, `application/meter.ts`, BILLING-PLAN.md) | Search and extract calls inside code charge the existing meters. Execution time is charged as a new CPU-seconds credit dimension, which updates the plan schema and BILLING-PLAN.md (D6). | P2 |
| API / SSE (`api-v1.ts`) | The request contract does not change. Code execution events stay trace-only; SSE keeps its existing user-facing event kinds. | P2 |
| CLI | `trace` already renders new events. `config` gains the sandbox block; `stats` shows code usage only if metering adds it. | P2 |
| Deployment / ops | Pyodide assets are bundled offline in the image; per-execution memory and CPU limits are enforced; Docker is the hardening path (D3). | P3–P4 |

## Evaluation

Fixed suite for every phase (ADR 0007): the immortal-snail query
(`.runquery2.txt`), the Parallel architecture query, the agent-architecture
query, and the digital-nomad query. Metrics recorded per run: LLM rounds,
fresh and cached tokens entering the model, tool calls, fetched pages, distinct
domains, primary-source ratio, answer characters, cost, wall clock. Citation
and source checks are deterministic and run before any LLM judging.

Baseline captured 2026-10-02 (current engine, `deep`/`long`): dogfood query
`j-M74E5cbkQtjl` — 61 rounds, 40 fetches, 399K fresh + 1.29M cached input
tokens (28,147 per round), ≈55K tokens in context at the final attempt,
≈$0.35, run lost to the forced-answer timeout. The snail query
`j-aRnUxmgzu8Sz` — 8 rounds, 5 fetches, 55K fresh + 189K cached input tokens
(30,540 per round), KYM carried 9 of 39 citations, primary record never
fetched. The numbers to beat are the per-round input (7–15x lower in P0) and
the outcome (both runs failed to answer).

## Risks

| Risk | Mitigation |
|---|---|
| Sandbox escape / prompt-injected code | No ambient capability; every effect is an engine-authorized RPC with budget, URL policy, and output caps. Docker is the hardening path. |
| Model writes broken programs | `qwen3.8-27b` is reportedly strong at code, but P0 measures it. Errors return as text for recovery; classic tools remain the fallback. |
| Prompt bloat | Code guidance is added only while removing the rules the harness makes unnecessary (semantic stop, recall discipline). Rules stay testable in `research-prompt.test.ts`. |
| Cache economics | Offload already rewrites prefixes (measured: 24 passes in one run). P3 measures the cost instead of assuming append-only stability. |
| Ops surface | Pyodide asset bundling and Deno binary packaging are deployment decisions; default-off config keeps production unchanged until a phase gate passes. |

## Decisions

- **D1 — P0 scope:** compare Deno and Pyodide on the same three queries.
  Decided 2026-10-02.
- **D2 — production language:** Python on Pyodide is the default; Deno remains
  the lightweight alternative. Decided 2026-10-02.
- **D3 — Docker:** later hardening backend, not a prerequisite.
  Decided 2026-10-02.
- **D4 — sandbox state on resume:** the checkpoint persists the model's explicit
  JSON `state` alongside the existing fields; page data is recovered from the
  evidence store; globals outside `state` do not survive. Decided 2026-10-02.
- **D5 — sandbox concurrency:** a configurable cap with a queue. Decided
  2026-10-02.
- **D6 — metering:** execution time is a new CPU-seconds credit dimension.
  Decided 2026-10-02.
- **D7 — two engines, not one loop with a switch:** `sandbox.enabled` selects
  between the classic loop (`engine.ts`) and the code engine
  (`code-engine.ts`). The tool lists, prompts and wrap-up semantics stay
  separate; only the spine (budget, sources, evidence, checkpoints, trace,
  report, model transport) is shared. The first P1 attempt offered `run_code`
  beside the classic tools inside the classic loop and measured zero `run_code`
  calls in two live runs, which is what forced the split. Decided 2026-10-02.
