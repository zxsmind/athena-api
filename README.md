# Athena

Self-hosted web research API with an MCP server. It answers a question by
searching the web, reading the pages it finds, and returning an answer with
inline citations tied to that job's source registry.

Three operations, over two transports. Every route under `/v1` has an MCP
equivalent, and both run the same code with the same billing and error shape.

| | |
|---|---|
| `POST /v1/search` | Ranked web results. No model involved. |
| `POST /v1/contents` | Readable text from one or more URLs. No model involved. |
| `POST /v1/research` | Background job that investigates and cites. Uses a model. |

A browser console ships with the server: a playground for the three API
operations and an operator section for keys, analytics, jobs and the model
catalog. The server serves it from its `public/` directory whenever one exists,
so the console is the same origin as the API it calls.

## Running it

Node.js 24 or newer. Three install roots, because the server and the web
console are their own packages:

```sh
npm install
npm install --prefix server
npm install --prefix web
npm run cli -- setup      # providers, keys, search backends
npm run dev               # API on :39921
```

The server refuses to open its listener until at least one LLM provider is
configured, and names what is missing rather than coming up unusable.

The console is optional: without `npm install --prefix web && npm run build
--prefix web` there is no `public/` directory, and the server runs exactly as
before — a pure API deploy.

### Docker

```sh
docker compose up --build -d
```

The image runs as the non-root `node` user, and the named volume keeps SQLite
state, settings, checkpoints, traces, routing state and the models.dev cache
across image updates. `ATHENA_PORT` changes the host port.

#### The admin key under Docker

On first boot the server generates the admin key that `/v1/keys` and
`/v1/analytics` need, writes it to `/data/admin.key` inside the volume, and
prints it **once** to the container log:

```sh
docker compose logs athena | grep -i "admin key"      # find it later
docker compose exec athena cat /data/admin.key        # or read the file
docker compose exec athena node server/dist/cli.js admin-key show
```

Restarting does not print it again — the volume already holds it, so the log
line above is from the first boot only. Three ways to keep hold of it:

- **Set it yourself** before the first boot (`ATHENA_ADMIN_KEY` in the compose
  environment, 16+ characters). The file is then never the source of truth and
  a redeploy cannot change it under you.
- **Read it back** from the volume at any time with either command above.
- **Rotate it** if it is truly gone: `… admin-key rotate` replaces it, prints
  the new value once, and the old key stops working immediately.

The console's `/admin` section asks for this key on first visit; it is kept in
the browser tab's session only.

## Web console

```sh
npm install --prefix web
npm run web                    # dev server on :5173, proxied to a local Athena
npm run build --prefix web     # builds into server/src/public
```

- `/` — playground: search, contents, and research with the live event stream, budget gauges and the cited answer.
- `/admin` — operator console: usage rollups, API keys, jobs and the models.dev catalog. Gated by the same local-network + `X-Admin-Key` rule the API enforces; the key lives in the tab's session only.
- No cookies, no CORS: every call carries the same `Authorization` / `X-Admin-Key` headers the API documents, from the same origin.

The server build copies the console into `dist/public`, so the Docker image
needs no extra step: the console is served whenever it has been built, and a
pure API deploy simply ships without one.

## Operating it

The CLI is for whoever runs the server. Nothing in this section is called by an
HTTP or MCP client.

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
models.dev catalog, or a custom endpoint), API keys and the 14 search backends.
Interrupting it changes nothing.

To call it as `athena` from any directory:

```sh
npm run link:cli             # builds and links `athena`
```

## MCP

Two transports, the same tools, the same configuration as the API.

Remote clients connect to `http://localhost:39921/v1/mcp` over Streamable HTTP.
They present the same `Authorization: Bearer <key>` the REST API uses; loopback
clients may omit it.

Local clients launch `athena mcp`, which speaks MCP over stdio using the same data
directory and settings as the CLI, and carries the same scope as loopback access.
After `npm run link:cli`, configure a stdio client with command `athena` and
argument `mcp`.

| Tool | Replaces |
|---|---|
| `athena_search` | `POST /v1/search` |
| `athena_read_contents` | `POST /v1/contents` |
| `athena_start_research` | `POST /v1/research` |
| `athena_list_jobs` | `GET /v1/jobs` |
| `athena_get_job` | `GET /v1/jobs/:id` |
| `athena_cancel_job` | `POST /v1/jobs/:id/cancel` |
| `athena_pause_job` | `POST /v1/jobs/:id/pause` |
| `athena_resume_job` | `POST /v1/jobs/:id/resume` |

Tool results carry the API response as JSON text. Failures are tool errors
carrying the same `code`, `message`, `details` and `retryable` fields. An API key
can list and operate only on jobs it created.

The `mcpAllowedHosts` list (`server` block in `config.yaml`) gates the Host and
Origin headers, because DNS rebinding is the realistic attack against a local
service. It defaults to `localhost`, `127.0.0.1` and `[::1]`; add a reverse-proxy
hostname to it and restart.

## API

```text
GET  /health
POST /v1/search
POST /v1/contents
POST /v1/research
GET  /v1/jobs
GET  /v1/jobs/:id
GET  /v1/jobs/:id/events
GET  /v1/models
POST /v1/mcp
```

Remote `/v1` requests require `Authorization: Bearer <key>`. Loopback requests
may use local access. Full contract: [docs/API.md](docs/API.md).

## Configuration

Two files in the data directory, neither committed.

| File | Holds |
|---|---|
| `settings.yaml` | Secrets: provider keys, search backend keys, model routing |
| `config.yaml` | Tunables: modes, limits, logging, pricing, plans |

`config.yaml` is a closed schema, so a typo fails validation instead of silently
falling back to a default. The four research modes are a fixed key set for the
same reason, and `config.yaml` is where a mode's ceilings, its reasoning effort
and its quality bar are changed. `athena about` prints the exact paths.

### Reasoning effort

A mode names a rung, not a value, and the value comes from the model:

| | `instant` | `default` | `deep` | `max` |
|---|---|---|---|---|
| Rung | none | low | medium | xhigh |

Effort is not settable per request. What a model receives depends on what it
accepts, and the models.dev catalog is the source: a model that does not think at
all never gets an effort value, a rung the model cannot express falls back to the
nearest value it does, and `modelEfforts` in the `research` block of `config.yaml`
overrides the rung for a specific model when the fallback is not what you want.

Values are clamped rather than stretched: a mode never asks a model for something
it rejects, and a provider floor in `settings.yaml` is applied before the model's
vocabulary is consulted.

### Data directory

Runtime state never lands in the checkout. With `ATHENA_DATA_DIR` set, that path
is used; otherwise the platform convention applies.

| Platform | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\athena` |
| macOS | `~/Library/Application Support/athena` |
| Linux | `$XDG_DATA_HOME/athena` or `~/.local/share/athena` |

A read-only checkout, a container and a notebook runtime all work unchanged.

Growth is capped from `config.yaml`: an hourly sweep cancels paused jobs past
`research.pausedTtlMinutes` (default 240) and purges terminal jobs, traces and
checkpoints past `storage.retentionMinutes` (default 1440). On top of those age
ceilings, `storage.maxDataBytes` (default 1 GB, `ATHENA_MAX_DATA_BYTES`) is a hard
disk guard that spends the oldest terminal data first. Running jobs are never
touched. The log file rotates under `logging.maxFileBytes` × `logging.keepFiles`.

## Research behaviour

| | `instant` | `default` | `deep` | `max` |
|---|---|---|---|---|
| Steps | 8 | 20 | 60 | 200 |
| Searches | 15 | 40 | 120 | 400 |
| Page reads | 15 | 40 | 120 | 400 |
| Billable tokens | 200K | 600K | 1M | 10M |
| Wall clock | 5 min | 20 min | 90 min | 4 h |
| Independent sources | 2 | 2 | 3 | 3 |

The wall clock binds the job rather than each round. A round gets what is left of
it minus a window held back for the answer, so a mode that spends a long time
thinking spends its own budget instead of being cut mid-thought; a streaming call
also ends if the provider goes silent for a minute, which measures the connection
rather than the work. Each step carries the duration it took and the effort that
reached the provider, on the job event stream, so a run can be read against the
budget it was given.

Every ceiling is reported when it is reached, and a job still gets its answer when
one stops it: the run answers from the evidence already gathered and states what
it could not confirm.

Two request fields are independent of the mode. `response_length`
(`short`, `long`, `exhaustive`) sets how much of the gathered evidence is written
down. `verbosity` (`summary`, `detailed`) sets what the caller sees while the job
runs: progress notes, and with `detailed` the reasoning behind them. Neither
changes what the model researches.

A long run compacts when it is enabled (`compaction` block in `config.yaml`, off by
default): the agent writes durable notes, raw payloads leave the context, and the
model reads its own notes back on demand.

Unfinished jobs with a checkpoint return `paused` after a restart and need an
explicit resume. Jobs without one become `failed`. Checkpoints are files in the
data directory, so a job's state survives a redeploy.

### Two engines

Athena runs one research loop, and the same budgets, ceilings, source
numbering, checkpointing and billing behind it:

- **Classic (tool-calling) — the default.** The agent calls `web_search` and
  `fetch_url` one round at a time. Everything described above is this engine.
- **Code (Pyodide sandbox) — `sandbox.enabled: true` in `config.yaml`.** The
  agent writes one Python program per round instead of calling tools; only the
  program's printed text and last expression come back. The sandboxed
  functions (`search`, `extract`, `read_source`, `plan`, `budget`) answer from
  the engine side, where budget and source registry live.

**The code engine is not production-ready.** It was written to evaluate the
approach — to measure whether an agent that codes its own research beats an
agent that calls tools — and it is deliberately narrower than the classic
engine: fewer measured paths, rougher edges, and known gaps. Keep
`sandbox.enabled: false` (the default) unless you are deliberately testing or
studying it. Any serious use — long runs, citations that have to hold,
resumable jobs — should use the classic engine. Support for the second engine
will be extended over time.

## Technology

- Node.js 24, Express 5, TypeScript 6.0 for the server (Smart Routing core stays on 5.9)
- Model calls through the Vercel AI SDK, routed across providers via the models.dev catalog (capabilities, context limits, pricing; 12 h refresh)
- SQLite (`node:sqlite`) for keys, analytics, jobs and events
- 14 search provider modules behind a registry, with key rotation
- Model Context Protocol SDK for the MCP transports

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).

A copy of the license travels with every distribution, and modified files carry a
notice stating they were changed, as section 4 of the license requires. Nothing
here grants permission to use the project's name or marks, which section 6 leaves
to its own terms.
