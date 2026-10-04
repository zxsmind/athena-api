# Athena

Athena is a self-hosted, backend-only web research API. It answers a question by
searching the web, reading the pages it finds, and returning an answer with
inline citations tied to that job's source registry.

Three primitives:

| | |
|---|---|
| **Search** | Ranked web results. No model. |
| **Contents** | Readable text from one or more URLs. No model. |
| **Research** | Background job that investigates and cites. Uses a model. |

There is no frontend in this repository. The deliverable is the HTTP API and a
CLI.

## Run locally

Node.js 24 or newer.

```sh
npm install
npm run cli -- setup      # interactive wizard: provider, key, search backend
npm run dev               # API on port 39921
```

The server refuses to open its listener until at least one LLM provider is
configured, and it says what is missing instead of coming up unusable.

## The CLI

```sh
npm run cli -- setup          # first-run wizard, saves once at the end
npm run cli -- config         # edit any setting later, no restart needed
npm run cli -- status         # configured providers, backends, liveness
npm run cli -- keys list
npm run cli -- stats
npm run cli -- logs
npm run cli -- trace <jobId>  # what the model actually did on a job
npm run cli -- repair         # SQLite integrity check, stale state cleanup
```

`athena setup` walks through the port, LLM providers (searchable across the
models.dev catalog, or a custom endpoint), API keys, and the 14 search backends.
Ctrl+C changes nothing.

To call it as `athena` from any directory:

```sh
npm run link:cli             # then `athena status`, `athena config`, ...
```

## Configuration

Two files, both in the data directory, neither committed:

| File | Holds |
|---|---|
| `settings.yaml` | Secrets: provider keys, search backend keys, model routing |
| `config.yaml` | Tunables: modes, limits, logging, pricing, plans |

`config.yaml` is a closed schema. A typo fails validation instead of silently
falling back to a default, and the four research modes are a fixed key set for
the same reason. `athena about` prints the exact paths.

`config.yaml` is the file to edit to change a research mode's ceilings, its
reasoning effort, or its quality bar.

## Data directory

Runtime state never lands in the checkout. With `ATHENA_DATA_DIR` set, that path
is used; otherwise the platform convention applies:

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\athena` |
| macOS | `~/Library/Application Support/athena` |
| Linux | `$XDG_DATA_HOME/athena` or `~/.local/share/athena` |

A read-only checkout, a container, and a notebook runtime all work unchanged.

Growth is capped from `config.yaml`: an hourly sweep cancels paused jobs past
`research.pausedTtlMinutes` (default 240) and purges terminal jobs, traces,
and checkpoints past `storage.retentionMinutes` (default 1440). Running jobs
are never touched. The log file rotates under `logging.maxFileBytes` ×
`logging.keepFiles`.

## Docker

```sh
docker compose up --build -d
```

The image runs as the non-root `node` user. The named volume keeps SQLite state,
settings, checkpoints, traces, routing state, and the models.dev
cache across image updates. `ATHENA_PORT` changes the host port.

## API

```text
GET  /health
POST /v1/search
POST /v1/contents
POST /v1/research
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events
GET  /v1/models
```

Remote `/v1` requests require `Authorization: Bearer <key>`. Loopback requests may
use local access. Full contract: [docs/API.md](docs/API.md).

## Research modes

| | `instant` | `default` | `deep` | `max` |
|---|---|---|---|---|
| Steps | 8 | 20 | 60 | 200 |
| Searches | 15 | 40 | 120 | 400 |
| Page reads | 15 | 40 | 120 | 400 |
| Billable tokens | 200K | 600K | 1M | 10M |
| Wall clock | 5 min | 20 min | 90 min | 4 h |
| Reasoning effort | `none` | `low` | `medium` | `xhigh` |
| Independent sources | 2 | 2 | 3 | 3 |

`mode` is the only effort selector; reasoning effort follows from it and is
not settable per request. The values above are what Athena requests — what the
provider makes of them depends on the model: capabilities come from the
models.dev catalog, providers that only accept `none`/`default` are handled
where the request is built, and models that must not receive an effort value
go in `disabledThinkingModels`. Two
further request fields are independent of it. `response_length`
(`short`, `long`, `exhaustive`) sets how much of the gathered evidence is
written down, and `verbosity` (`summary`, `detailed`) sets what the caller sees
while the job runs: progress notes, and with `detailed` the raw reasoning
behind them. Neither changes what the model researches.

A long run compacts: the agent writes durable notes, raw payloads leave the
context, and the model reads its own notes back on demand.

## Technology

- Node.js 24, Express 5, TypeScript 5.9
- Model calls through the Vercel AI SDK, routed across providers via the models.dev catalog (capabilities, context limits, pricing; 12 h refresh)
- SQLite (`node:sqlite`) for keys, analytics, jobs, and events
- 14 search provider modules behind a registry, with key rotation
- `@inquirer/prompts`, `ora`, `picocolors`, `js-yaml` for the CLI

## Operating boundary

Unfinished jobs with a checkpoint return `paused` after a restart and need an
explicit resume. Jobs without one become `failed`. Checkpoints are
files in the data directory. Use `/v1` for external clients.

Known gap: long runs have no context management yet.
