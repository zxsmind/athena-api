# Athena architecture

## What this is

Athena is a backend-only web research API. It answers research questions by
searching the web, reading the pages it finds, and returning a cited answer.
There is no user interface: the deliverable is the HTTP API and a CLI.

Three capabilities, all under `/v1`:

| Endpoint | What it is | Model needed |
|---|---|---|
| `POST /v1/search` | Web search. Returns ranked results. | no |
| `POST /v1/contents` | Fetches one URL, returns readable text. | no |
| `POST /v1/research` | Asynchronous job. Searches, reads, cites. | yes |

Search and Contents are deterministic retrieval. Only Research calls a model.

## Runtime shape

```text
athena (Express 5)
├─ /health                      liveness, no auth
└─ /v1
   ├─ POST   /search             → search registry → 14 providers
   ├─ POST   /contents           → extractor (HTML + PDF)
   ├─ POST   /research           → job (202) ─┐
   ├─ GET    /jobs               ─────────────┤
   ├─ GET    /jobs/:id           ─────────────┤ research loop
   ├─ GET    /jobs/:id/events    ─────────────┘ (SSE)
   ├─ POST   /jobs/:id/cancel | pause | resume
   ├─ GET    /models             catalog + context + pricing
   ├─ GET    /keys               list own key
   ├─ POST   /keys               create
   └─ DELETE /keys/:id           revoke

   CLI: athena <command>          config, keys, stats, logs, trace, repair
```

Everything is English. Runtime data lives outside the source tree, in a
platform data directory (see `server/src/data-dir.ts`).

## Layering

```text
api-v1.ts            HTTP surface: auth, schema validation, analytics
  └─ research-jobs.ts    job records, persistence, event replay
      └─ application/
         ├─ research-runner.ts   job lifecycle, terminal billing
         └─ meter.ts             rate limit, slot admission, charging
              └─ engine/
                 ├─ engine.ts        classic loop; public engine selector
                 ├─ modes.ts         mode contract, budget, ceilings
                 ├─ plan-tools.ts    plan state (cursor reads)
                 ├─ retry.ts         error backoff
                 ├─ report.ts        evidence report assembly
                 ├─ report-run.ts    shared v1 report builder
                 ├─ sandbox-handlers.ts  RPC handlers for program calls
                 └─ report-llm.ts    claim extraction
  └─ code-engine.ts  the code loop (sandbox.enabled)
  └─ sandbox/        per-job interpreter: host, session, manager (opt-in)
  └─ llm.ts          provider invocation, smart routing, usage
  └─ search/         14 provider modules + registry
```

`index.ts` is the composition root. It is the only place that builds the
`Meter`, so the router and the job runner share one instance.

## The research loop

`agenticResearchStream()` in `engine.ts` runs rounds. Each round:

1. Drops later system messages, keeping `messages[0]`
2. Calls the model with tools
3. Executes tool calls, appends results
4. Stops when a ceiling is reached or the model answers

Nothing is injected between rounds. The sequence is system prompt, the query, then
assistant and tool results.

There is no separate synthesis phase. The model either calls tools or writes the
answer.

### Tools

| Tool | Engine | Purpose |
|---|---|---|
| `web_search` | classic | Batched queries, returns `[Source #N]` numbered results |
| `fetch_url` | classic | Reads one page |
| `create_plan` / `edit_plan` | classic | Research checklist |
| `read_plan` | classic | Reads the plan (it is not in context) |
| `recall_source` | classic | Re-reads a source offload cleared |
| `report_progress` | classic | Publishes a status note to the user |
| `read_budget` | classic | Remaining budget on demand; answered after the turn's charges |
| `decline_request` | classic | Ends a non-question as declined; terminal, work done billed |
| `run_code` | code | Runs a Python program in the job's sandbox |

The classic engine has an internal `ResearchRunOptions.planningEnabled` switch
for controlled experiments. It defaults to enabled; when disabled, the classic
prompt and tool list omit `create_plan`, `edit_plan`, and `read_plan`. The HTTP
API does not expose this switch. Evidence and mode policies remain enabled in
both variants.

The code engine's list is exactly one entry: `run_code`.

## Code execution is a second engine

`agenticResearchStream` is the entry point and the selector: `sandbox.enabled`
routes to `code-engine.ts`, otherwise to the classic loop. They are two engines
on a shared spine — budget counters, modes, checkpoints, tracing, the evidence
store, the model transport and the v1 report are shared; tool lists, prompts and
wrap-up semantics are not. The classic loop never sees `run_code`, and the code
engine's prompt never names `web_search` or `fetch_url`.

Inside a code job, the only tool is `run_code`. The program runs in a Pyodide
interpreter owned by the job; `search`, `extract` and `read_source` are async
functions the engine answers over JSON-RPC. Only the printed text and the last
expression re-enter the conversation — raw page text stays in the interpreter,
which is the whole point.

Measured live (2026-10-02, immortal-snail query, `deep`/`long`): 19 rounds, 27
programs, 40 sources, 9,724 input tokens per round against 30,540 on the classic
path, 68% of input served from cache, answer 5,698 chars in 85 s. P0 measured
the same shape across three queries. See
[CODE-EXECUTION-PLAN.md](CODE-EXECUTION-PLAN.md). The two-engine split is D7:
the first attempt put `run_code` beside the classic tools and measured zero
`run_code` calls in two live runs.

What the boundary guarantees:

- Budget and source numbering stay on the engine side: every injected call
  charges the same meter as the classic tools, and every source gets the same
  `[Source #N]` index, so a citation resolves the same way from either engine.
- The interpreter has no ambient capability. `fetch` and friends are removed
  before Pyodide loads, the host filesystem is not mounted into the Python VFS,
  and the child process receives a scrubbed environment (`PATH` and the Windows
  basics only), because `js.process` remains reachable from Python.
- A timed-out program kills the interpreter. The next program starts a fresh one
  and replays the last exported `state`; globals outside `state` are lost by
  design and page text is recovered from the evidence store with `read_source`.
- `sandbox.maxConcurrent` bounds simultaneous executions; excess runs queue, and
  an aborted job drops out of the queue.

The engine is off by default. The P0 spikes also showed that code execution
alone does not converge — none of six spike runs reached synthesis in eight
rounds — so budget-driven synthesis remains P3, and the prompt states the print
budget instead of relying on an invisible clip.

## Context is the agent's to manage

The engine does **not** push its state into the prompt. Three ideas follow from
this, and all three were learned the hard way:

**The model drives its own memory.** It reads the plan with `read_plan()`.
Re-injecting the notebook body, the ledger, and the source map on every round cost about 2,500 tokens per turn, grew with the research, and left nothing cacheable. (The notebook named here is gone now; see below.) The model's own reasoning is the exception: it stays verbatim in history and re-enters as `reasoning` parts, because thinking models deliberate across rounds in it. Narration is still shown, never replayed.

**Nothing sits between the model and the end of its prompt.** A per-round
manifest survived longer than any of the other injected state, because it was the
last thing before the model's own reasoning. With it in place, runs sometimes
answered a preamble in four seconds without calling a tool. Removed, the same
query ran 30 rounds and 39 tool calls.

**Cache prefixes stay stable.** The conversation is append-only between rounds and
nothing is prepended, so the cached prefix covers the whole history. A live run
showed 22,400 of 28,400 input tokens served from cache.

The source index is never injected separately: every search and fetch result
already carries its own `[Source #N]`.

## Status notes are a tool, not prose

The note a user sees while a job runs is a `report_progress` tool call, not text
the model writes alongside its reasoning.

Asking for prose in the prompt failed for eight attempts. Inside the real prompt
the model produced a well-formed note in roughly one turn out of seventeen; the
same instruction in a short isolated prompt worked almost every time, so the
problem was prompt weight rather than the model. Two further findings shaped the
schema: telling the model a lazy note is worthless silenced it entirely, five
turns out of five, so the `body` description says what a good note contains
instead of what a bad one may not; and the headline length is not enforced,
because refusing a call costs a turn to explain the refusal.

Moving the tool out of the prompt entirely did not work either. With the schema
defined and the prompt silent, five live runs produced zero `report_progress`
calls across sixteen tool calls, while `create_plan`, `write_notebook` and
`recall_source` were all used. The model will call a tool whose purpose it can
infer; this one has no self-evident reason to exist next to `web_search`. The
prompt now names it, and states the cadence and quality bar there as well, so
neither copy can be edited without the other drifting.

The cadence also needed a second pass. "Every two to four rounds" was read as a
counter rather than as work: a measured run published at rounds 0, 2 and 4, and
the round-0 note sat beside a search whose results had not arrived, describing
work that had not happened. The prompt asks instead whether the note could have
been written before the round it accompanies, which separates a finding from a
plan.

The engine publishes the note as a `progress` event and returns `ok`, so a note
costs no tokens, never appears in `answer`, and does not count against the job
budget. See [PROMPTS.md](PROMPTS.md) for the exact schema and a measured example.

## Modes

One effort axis. A mode names its ceilings, its reasoning effort, and the quality
bar its prompt asks for. Both engines append the policy from `modes.ts`; the
classic policy names `fetch_url` and the code policy names `extract`. `max`
includes the complete deep requirements rather than referring to an unseen
deep-mode prompt. The policy is an instruction, not a measured quality guarantee.

| | `instant` | `default` | `deep` | `max` |
|---|---|---|---|---|
| `maxSteps` | 8 | 20 | 60 | 200 |
| `maxSearchCalls` | 15 | 40 | 120 | 400 |
| `maxFetchCalls` | 15 | 40 | 120 | 400 |
| `maxBillableTokens` | 200K | 600K | 1M | 10M |
| `minFetchCalls` | 10 | 15 | 30 | 80 |
| `minSearchCalls` | 4 | 8 | 20 | 50 |
| `maxWallClockMs` | 5 min | 20 min | 90 min | 4 h |
| reasoning effort | `none` | `low` | `medium` | `xhigh` |
| `minIndependentSources` | 2 | 2 | 3 | 3 |
| `wrapUpToolCalls` | 8 | 20 | 60 | 200 |
| `forceAnswerToolCalls` | 12 | 30 | 90 | 300 |

Reasoning effort is derived from the mode. It is not a request field, so a caller
cannot pair a cheap mode with an expensive thinking budget.

The classic loop counts executed `web_search` and `fetch_url` invocations, not
rounds or the queries/pages inside one invocation. Plan, recall and progress
calls do not advance that counter. The code loop counts executed programs.
Both engines send one `[wrap-up]` user message at the mode's tool threshold or
before the last available research step, while tools are still available.
The force-answer threshold or a reached ceiling removes tools for synthesis.
Search queries and page reads have independent allowances; searches do not
subtract from the page-read allowance in the same round. A spent allowance
retires only its own tool — the run continues on the other while steps,
tokens, and time remain. Only hard ceilings (wall clock, steps, tokens) or
both allowances out remove the tools and force the answer. The code loop
keeps `run_code` listed throughout (it has no other tool) and retires the
spent RPC capability with the same once-only notice instead.

Ceilings allow more work; they do not require a job to use all of its budget.
The floor does require a minimum: `minFetchCalls` pages read and no plan item
still open, or an early answer is bounced with one `[evidence-floor]` message
and the run continues. The division is mechanical versus semantic — the engine
owns the minimum, the model judges coverage and contradictions — and the floor
never fires once a ceiling has forced the answer. A plan is likewise
mechanical at its edges: `create_plan` before any search or fetch is rejected,
and a `done` item must carry `evidence` source numbers the job has seen.
End-to-end quality and duration need live evaluation.

### Two limits, not one

`maxBillableTokens` is a **spend limit**, not a context limit. It counts
cumulative billable tokens, and cache reads are excluded: they re-read a prefix
the provider already holds and cost a fraction of a fresh input token. Counting
them at face value stopped long runs for work they did not pay for.

The context is bounded by the model's own window. `BudgetSnapshot` reports both
numbers. The engine enforces the mode's token ceiling; the plan's
`maxBillableTokensPerJob` is currently declared in configuration but is not
applied to the research preset by the API or runner.

### Retries, not pacing

The engine does not wait between rounds. Waiting only ever made sense after a
failure, so it lives in `retry.ts`: a failed search or fetch retries on
`research.retryDelaysMs` (1s, 2s, 4s, 6s, 10s), honouring a provider
`Retry-After` header when present. After the last delay the call is dropped and
the real reason is recorded. A healthy run never waits.

## The evidence report

`/v1/research` returns `result.report`, an `athena-research-report/v1` object.
It is structured data, not prose.

Evidence IDs are job-local and deterministic: `ev_001` is the source with
`source_index = 1`. A finding survives only if at least one of its `citation_ids`
resolves to an ID in that job. Unknown IDs are dropped; a finding left without
evidence becomes a `gap` instead of a reported finding.

If claim extraction cannot reach a model, the report falls back to splitting the
validated prose answer on its `[N]` markers, so a report is still produced.

## Observability

| Tool | Answers |
|---|---|
| `athena logs` | Did the request succeed? |
| `athena trace <jobId>` | What did the model actually do? |
| `GET /v1/jobs/:id/events` | What is happening right now? |

The log file records outcomes. It cannot answer which route was chosen, what was
sent to the provider, what the model reasoned, or which tool it called. That is
what the trace is for: per-job JSON Lines, written as the run proceeds so a live
tail works on a running job.

Traces are opt-in (`logging.trace`), because they contain full prompts, reasoning,
and fetched page content.

## Configuration

`config.yaml` holds tunables, `settings.yaml` holds secrets. Both live in the
data directory and are not committed.

`config.yaml` is a closed schema: a typo fails validation instead of silently
falling back to a default. `modes` is a fixed set of four keys for the same
reason.

`sandbox` (`enabled`, `backend`, `timeoutMs`, `maxOutputChars`,
`maxConcurrent`) is off by default; `backend` names the one measured runtime,
`pyodide`.

Startup refuses to open the listener without at least one enabled provider with
a key. A missing search backend is a warning, not a failure, and the affected
endpoints return `503 SEARCH_NOT_CONFIGURED`.

## Known gaps

- **Context management is partial.** The notebook and its tools were removed
  after measuring fourteen writes across six runs and zero reads. The classic
  loop now has opt-in Tier 1 offload (`compaction.ts`, `stubs.ts`, `triggers.ts`,
  `evidence-store.ts` and `recall_source`); it needs a known model window for
  proactive passes. Later search snippets cannot overwrite a fetched page in
  the evidence store. The rebuild is in [COMPACTION.md](COMPACTION.md) and was
  observed live (three passes clearing 4/5/8 messages, zero dangling citations).
  Semantic summarization is not built, and the code loop has no conversation
  compaction. Long runs can still reach `context_length_exceeded`.
- **No prompt evaluation.** The prompt is regression-tested for wording, not for
  answer quality. There is no golden set and no scoring.
- **Code execution is P1, not P4.** The code engine returns the prose answer and
  the v1 report, but it has no `report_progress` notes and no plan tools yet:
  the model's own `state` is the plan, and the SSE stream shows `code` steps.
  The sandbox's `extract` answers a `question` with keyword-scored excerpts
  and reads batches of up to 4 pages; without a question it clips the page
  head. Execution time accumulates per program into `used_cpu_seconds`,
  billed at the provisional CPU rate. Isolation is process-level, not adversarial-grade: `js.process` is
  reachable from Python even though its environment is scrubbed, and Docker
  remains the hardening path (P4/D3). Budget-driven synthesis is not built
  (P3), so a code job stops through the same wrap-up signal a classic job does.
  Cache behaviour is now measured rather than assumed: the live code run served
  68% of input tokens from cache.
- **Execution time is metered.** Code-engine programs accumulate wall-clock
  seconds into the job budget (`used_cpu_seconds`), billed at the provisional
  `pricing.researchCpuSecond` rate. Classic runs stay at zero.
- **A zero-source answer is accepted, by decision.** A measured code run
  answered a research question from model memory in round 0 (zero tool calls,
  3,241 output tokens) and the draft reached the answer path; the caller sees
  `sources: []`. A blanket refusal was drafted and rejected on review: it would
  force research on a non-research input (a greeting is not a research request)
  and reads a model choice as an engine precondition. How often this happens,
  and whether it matters next to the classic engine's rate, is a fixed-suite
  measurement — not something to patch with a guard.
