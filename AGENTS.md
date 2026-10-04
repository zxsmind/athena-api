# AGENTS.md

Working agreement for coding agents on this repository.

**This file is the single source of truth for the architecture.** If code and
this document disagree, code is right and this document is a bug. Fix it in the
same change.

## Project

Athena is a backend-only, evidence-first web research API. Node.js + Express +
TypeScript. No frontend in this repository.

A research request runs an agentic loop: the model calls `web_search` and
`fetch_url`, reads what comes back, tracks evidence needs, and finally answers
with inline `[N]` citations tied to that job's source registry. Search and
Contents are deterministic and need no model.

Start with [README.md](README.md), then [docs/API.md](docs/API.md).

## Non-negotiable rules

1. **Everything in the repository is English.** Code, comments, prompts, error
   messages, documentation, commit messages. The user speaks Turkish; the
   project does not. If you find Turkish text, remove it.
2. **No backwards compatibility.** No migration shims, no legacy field names, no
   `if (old) ... else` for a renamed setting. Rename it and fix the callers.
3. **Secrets never enter the repository.** `settings.yaml` and `config.yaml`
   hold API keys. They are gitignored. Never commit them, never paste a real key
   into a test, a log, or a document.
4. **Runtime data never lands in the checkout.** Everything goes through
   `server/src/data-dir.ts` → `getDataPath()`. If you find yourself writing to
   `server/data`, you are doing it wrong.
5. **Do not claim behaviour you have not measured.** A field that is stored,
   returned by the API, and written to a checkpoint but read by nothing is dead
   weight, and this repository already shipped one. Either wire it up or delete
   it. There is a test convention below for catching the next one.
6. **Minimal change.** Follow the existing conventions. Do not refactor
   adjacent code because it looks nicer.

## Stack and layout

| | |
|---|---|
| Runtime | Node.js 24, ES modules, `type: "module"` |
| Server | Express 5, TypeScript 5.9 strict |
| Model calls | AI SDK (`ai` package) |
| Storage | SQLite via `node:sqlite` |
| CLI | `@inquirer/prompts`, `ora`, `picocolors` |
| Config | `js-yaml`, closed Zod schema |
| Tests | Vitest |

```text
server/
├─ src/
│  ├─ index.ts              composition root: config, logger, guard, listener
│  ├─ api-v1.ts             HTTP surface: auth, validation, analytics
│  ├─ engine.ts             classic research loop; engine selector
│  ├─ code-engine.ts        code research loop (`sandbox.enabled`)
│  ├─ llm.ts                provider invocation, routing, usage
│  ├─ trace.ts              per-job execution trace (opt-in)
│  ├─ agent/                prompt bodies
│  ├─ application/          job lifecycle, metering
│  ├─ cli/                  CLI implementation
│  ├─ config/               schema, defaults, loader
│  ├─ engine/               modes, plan, retry, report, checkpoint
│  ├─ sandbox/              per-job interpreter (opt-in `run_code`)
│  └─ search/               14 provider modules + registry
├─ tests/                   Vitest
└─ smart-routing-core/      local routing package
```

Imports in `server/` use the `.js` extension. `tsconfig` has `noUnusedLocals` and
`noUnusedParameters` on; an unused import is a build error.

## Configuration

`config.yaml` tunables, `settings.yaml` secrets. Both in the data directory.

`config.yaml` uses a **closed schema**: unknown keys fail validation rather than
being ignored, and `modes` is a fixed set of four keys. This is deliberate — a
typo that silently fell back to a default cost us a debugging session once.

Research modes are the single effort axis. A mode names its ceilings, its
reasoning effort, and the quality bar its prompt asks for. There is no second
profile selector; it was removed as redundant.

Both engines append the same mode policy, rendered with `fetch_url` for the
classic loop and `extract` for the code loop. The `max` policy includes its deep
requirements explicitly. Ceilings permit work; they do not guarantee a minimum
duration, full budget use, or answer quality. Per-mode fetch and search
floors plus a closed plan gate early answers instead: below them, one
`[evidence-floor]` message bounces the answer back. The numbers travel in
the mode block so the model plans to meet them. The engine owns the
minimum, the model judges coverage.

The classic wrap-up counter counts executed search/fetch tool invocations,
not rounds or queries/pages inside a batch. Plan, recall and progress calls do
not count. The code counter counts programs. Both engines warn once at the
mode's wrap-up threshold or before the last available research step, and remove
tools at the force-answer threshold or a ceiling. Searches and page reads have
independent budgets, including when issued in the same round. A spent
allowance retires only its own tool; only hard ceilings or both out force
the answer.

`maxBillableTokens` is a **spend limit**, not a context limit. Cache reads are
excluded from it: they re-read a prefix the provider already holds and cost a
fraction of a fresh input token. The context is bounded by the model's own
window.

## Design rules that are load-bearing

**The agent manages its own context.** The engine does not push its state into
the prompt between rounds. Closing instructions are appended only at execution
limits; they are not a per-round state manifest. The model reads the
plan with `read_plan` when it needs it. (A notebook used to be read the same
way; it was removed as write-only. See ARCHITECTURE.md.)
Re-injecting that state every round cost ~2,500 tokens per turn, grew with the
research, and left nothing cacheable.

**Nothing between the model and the end of its prompt.** A per-round manifest
outlived every other piece of injected state, because it was the last thing before
the model's own reasoning. With it in place, runs sometimes answered a preamble in
four seconds without calling a tool. Removed, the same query ran 30 rounds and 39
tool calls.

**Status notes are a tool call, and the prompt has to name it.** `report_progress`,
not prose. Eight attempts to hold the note as a prose rule produced a well-formed
note in roughly one turn out of seventeen inside the real prompt, while the same
instruction in a short isolated prompt worked almost every time. Tying the note
to a schema also moved the format decision into the engine.

The schema alone was not enough, which is the part worth remembering. With the
tool defined and the system prompt silent about it, five live runs produced zero
calls across sixteen tool calls while `create_plan`, `write_notebook` and
`recall_source` were all used. A tool the prompt never mentions is one whose
purpose has to be inferred, and this one has no self-evident reason to exist next
to `web_search`. Cadence and quality bar now live in both the prompt and the
schema.

The cadence needed a second pass. "Every two to four rounds" was read as a
counter, not as work: a measured run published at rounds 0, 2 and 4, and the
round-0 note was a statement of intent beside a search that had not returned yet.
The prompt now tests each note against the round it accompanies — if it could have
been written before that round, it is a plan, not a finding.

On prohibitions: general ones cost compliance here. Telling the model a lazy note
is worthless silenced it entirely, five turns of five. A prohibition that names a
specific failure is a different thing and does hold.

**Cache prefixes must stay stable.** The conversation is append-only between
rounds. Moving the system prompt or prepending anything volatile invalidates the
whole prefix. A live run served
22,400 of 28,400 input tokens from cache.

**Only a failure buys a delay.** `retry.ts` retries a failed search or fetch on
`research.retryDelaysMs`, honouring a provider `Retry-After`. A healthy run never
waits. There is no inter-round pacing; it was removed because it cost 44% of
wall-clock time on runs that had no errors.

**Code execution is an RPC boundary, and a second engine.** `sandbox.enabled`
selects `code-engine.ts` instead of the classic loop (D7) — one engine at a
time, selected by the flag, never a shared tool list. The code engine's only
tool is `run_code`, whose Python program reaches the web only through `search`,
`extract` and `read_source` answered by the engine. Budget, source numbering and
evidence stay on the engine side, so a citation from the sandbox resolves like
one from `web_search`. Only printed text and the last expression re-enter the
conversation; full pages stay in the engine's evidence store and programs load
passages with `read_source`. A later search snippet never replaces a fetched
page's full text or provenance. The interpreter is a
separate Pyodide process with `fetch` removed and a scrubbed environment; a
timeout kills it and the next program replays the last exported `state` (D4).
The classic loop never sees `run_code`, and the code prompt never names a
classic tool. Measured: offered beside the classic tools, `run_code` was called
zero times in two live runs. Off by default.

**Do not assert what you cannot check.** The old compaction note used to say
"Evidence preserved" while the engine could not verify that the note the model
had just written actually covered the payload being dropped. It said what
happened instead. Tier 1 source offload has since been rebuilt for the classic
loop; semantic summarization is still absent.

**The model is not told its own effort level.** Reasoning effort follows the
mode. Telling the model would be a suggestion, and the model already writes
better when it does not have to guess.

## Things that are deliberately not done

| | |
|---|---|
| Semantic context compaction | Not built. The classic loop has opt-in Tier 1 source offload; the code loop has no conversation compaction. The removed notebook measured as write-only (fourteen writes, zero reads). |
| Prompt evaluation | The prompt is regression-tested for wording, not answer quality. No golden set, no scoring. |
| Parallel tool execution | `maxWorkers` / `maxParallel` were removed rather than reserved. Nothing read them. |
| Backwards compatibility | Removed on purpose. Do not reintroduce it. |

## Testing

```sh
cd server
npx tsc --noEmit          # types
npm test                  # vitest
npm run build             # dist
cd .. && npm run lint     # eslint
```

A change is not done until all four pass. Tests run in about 5 seconds; run them
rather than reasoning about whether a change is safe.

Conventions:

- A test names the behaviour, not the function. `'does not charge cache reads
  against the ceiling'`, not `'testChargeTokens'`.
- When you change a contract, change the test that asserts it. A stale
  assertion is worse than a missing one, because it passes.
- **Test multi-byte input wherever a value is a byte offset.** JavaScript slices
  a string by character, not byte. Every offset-based reader in this repository
  went through this bug; the deleted `notebook-md.test.ts` had a Turkish/Japanese case
  specifically to keep it fixed, and `read_plan` keeps the same cursor contract.
- Mock the provider, not the network. A test that reaches the internet is a test
  that fails on someone else's machine.

## Live verification

Unit tests cannot tell you whether the model plans deeply, whether it publishes
progress notes, or whether a long run completes. For that:

```yaml
logging:
  trace: true      # config.yaml, then restart
```

```sh
npm run cli -- trace <jobId>            # every event, one line each
npm run cli -- trace <jobId> --kind tool.call,progress
npm run cli -- trace <jobId> --full
```

The trace records every provider attempt with its route, reasoning, tool calls
with arguments, progress notes, and the final outcome including
`answer_chars`. `run.end` with `outcome: no_answer` is the failure to look for.

Traces contain full prompts and page content. Keep them off in normal operation
and delete them when done.

## Before you finish

- [ ] `npx tsc --noEmit`, `npm test`, `npm run build`, `npm run lint` all pass
- [ ] No new Turkish text anywhere
- [ ] No new field that is written but never read
- [ ] Contract changes are reflected in `docs/API.md`
- [ ] **This file is updated if the architecture changed**
- [ ] The change is shown to the user before committing

## Committing

Only when explicitly asked. Inspect `git status`, `git diff`, and
`git log --oneline -10` first. Stage only what belongs to the change. Never
commit secrets. Write a message that says what changed and why, in the past
tense, matching the existing style.

## Documentation map

| File | Covers |
|---|---|
| [docs/API.md](docs/API.md) | The public HTTP contract |
| [README.md](README.md) | Install, run, configure |
