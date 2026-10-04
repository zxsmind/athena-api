# API reference

Base URL `/v1`. Every request except `GET /health` requires an API key.

Athena has three surfaces. `/search` and `/contents` are deterministic: they call
a provider and return what it returned, with no model involved. `/research` runs
an agentic loop that calls the same tools, keeps notes, and answers with inline
`[N]` citations tied to the job's source registry.

| | |
|---|---|
| Auth | `Authorization: Bearer <key>` |
| Content type | `application/json` |
| Errors | `{ "error": { "code", "message", "details?", "retryable" } }` |

---

## Contents

- [Authentication](#authentication)
- [Public deployments](#public-deployments)
- [Errors](#errors)
- [Endpoints](#endpoints)
- [`GET /health`](#get-health)
- [`POST /search`](#post-search)
- [`POST /contents`](#post-contents)
- [`POST /research`](#post-research)
- [Jobs](#jobs)
- [`GET /jobs`](#get-jobs)
- [`GET /jobs/:id`](#get-jobsid)
- [`GET /jobs/:id/events`](#get-jobsidevents)
- [`POST /jobs/:id/cancel`](#post-jobsidcancel)
- [`POST /jobs/:id/pause`](#post-jobsidpause)
- [`POST /jobs/:id/resume`](#post-jobsidresume)
- [`GET /models`](#get-models)
- [`GET /analytics`](#get-analytics)
- [Key management](#key-management)
- [Research controls](#research-controls)
- [Research result contract](#research-result-contract)
- [Progress notes](#progress-notes)
- [Billing](#billing)

---

## Authentication

Send the key in the `Authorization` header:

```sh
curl https://your-host/v1/research \
  -H "Authorization: Bearer ath_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"What changed in EU data retention law in 2026?"}'
```

An unknown or revoked key returns `401 UNAUTHORIZED`. A valid key on a plan that
does not allow the call returns `403` with a code naming the limit.

`GET /health` is the only unauthenticated endpoint, so an uptime check needs no
credential. Requests from the machine itself (loopback) also skip key auth;
everything else needs a key.

## Public deployments

Binding `0.0.0.0` and publishing the port is enough to serve the internet, but
two settings decide whether that is safe:

- **Reverse proxy**: address checks use the socket peer. A same-host proxy
  (nginx, Caddy) makes every request look like loopback, which skips key auth.
  List the proxy in `server.trustedProxies` (`ATHENA_TRUSTED_PROXIES`,
  IPs or CIDR) so `X-Forwarded-For` is believed only through it. With nothing
  listed, a forwarded header from a direct connection is ignored.
- **Page fetching**: `extract` refuses loopback, private, and cloud-metadata
  addresses in any IP notation, re-validates every redirect hop, and rejects
  names that resolve to internal addresses — so a stranger with an API key
  cannot turn the server into a probe of your network.

## Errors

Every failure has the same shape:

```json
{
  "error": {
    "code": "CONCURRENCY_LIMIT",
    "message": "Too many research jobs are already running for this key.",
    "details": { "max_concurrent_jobs": 2, "active_jobs": 2 },
    "retryable": true
  }
}
```

`retryable` is derived from the status code: `5xx` is retryable, `4xx` is not.

| Code | Status | Cause |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing, unknown, or revoked key |
| `NOT_FOUND` | 404 | No such research job |
| `CONCURRENCY_LIMIT` | 429 | Too many jobs running for this key |
| `SEARCH_NOT_CONFIGURED` | 503 | No search provider has a key configured on the server |
| `SCHEMA_VIOLATION` | 400 | Body failed schema validation; `details` carries the issues |
| `LOCAL_MANAGEMENT_ONLY` | 403 | Key management is not exposed publicly |

`SEARCH_NOT_CONFIGURED` is a server-side misconfiguration, not a client error. It
means no search provider is set up, so `/search`, `/contents` and `/research`
cannot work.

---

## Endpoints

### `GET /health`

```json
{ "status": "ok", "service": "athena-api", "version": "v1" }
```

No authentication. Intended for uptime checks, so it needs no credential.

### `POST /search`

Deterministic web search. One provider call, no model, no reasoning.

**Request.** Only `query` is required.

| Field | Type | Default | Notes |
|---|---|---|---|
| `query` | string, 1–2000 | — | Required |
| `type` | enum | `search` | `search`, `news`, `images`, `videos`, `places`, `shopping`, `scholar`, `patents` |
| `count` | integer 1–20 | `8` | Result count |
| `country` | 2-letter code | configured | Case-insensitive |
| `language` | 2 or 3 letters | configured | Case-insensitive |
| `time_range` | enum or null | `null` | `day`, `week`, `month`, `year` |
| `depth` | enum | `passages` | How much of each page to extract: `links`, `passages`, `full` |
| `include_domains` | string[] | `[]` | Max 30 hosts |
| `exclude_domains` | string[] | `[]` | Max 30 hosts |

```sh
curl https://your-host/v1/search \
  -H "Authorization: Bearer ath_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"solid state battery energy density 2026","count":5,"depth":"passages"}'
```

**Response.**

```json
{
  "query": "solid state battery energy density 2026",
  "applied": {
    "country": "us", "language": "en", "time_range": null, "depth": "passages"
  },
  "metadata": { "provider": "serper", "count": 5, "elapsed_ms": 412 },
  "results": [
    {
      "title": "Solid-state batteries reach 400 Wh/kg",
      "url": "https://example.org/ssb-400",
      "snippet": "A cell measured at 401 Wh/kg gravimetric…",
      "source": "serper",
      "date": "2026-03-11"
    }
  ]
}
```

`depth: "full"` returns page bodies rather than snippets and costs more.

### `POST /contents`

Extracts readable text from URLs. Used by `/research` internally, and useful on
its own when you already know the pages.

**Request.**

| Field | Type | Notes |
|---|---|---|
| `urls` | string[] | 1 to 20 URLs, each 1–2048 chars |

```json
{ "urls": ["https://example.org/a", "https://example.org/b"] }
```

**Response.** One entry per URL, in request order, with the extracted content and
the source number the answer should cite it as.

### `POST /research`

Starts an agentic research run. Returns immediately with a job id; the work
happens in the background.

**Request.** Only `query` is required.

| Field | Type | Default | Notes |
|---|---|---|---|
| `query` | string, 1–8000 | — | Required |
| `mode` | enum | `default` | `instant`, `default`, `deep`, `max` |
| `response_length` | enum | `long` | `short`, `long`, `exhaustive` |
| `verbosity` | enum | `detailed` | `summary`, `detailed` |

`mode` and `response_length` and `verbosity` are three independent axes. See
[Research controls](#research-controls).

The job runner passes the stored `response_length` to either research engine,
which appends that length's definition to the model prompt. The mode's research
policy also applies to both engines, using each engine's own tool vocabulary.
Mode budgets are upper limits, not minimum durations or spending targets.
The internal planning experiment switch is not part of the HTTP request and
remains enabled for API research jobs.

```sh
curl https://your-host/v1/research \
  -H "Authorization: Bearer ath_..." \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Which countries have digital nomad visas in 2026 and what income do they require?",
    "mode": "deep",
    "response_length": "long",
    "verbosity": "summary"
  }'
```

**Response.** `202 Accepted`.

```json
{
  "job_id": "j-A0OiglyGQuI2",
  "status": "queued",
  "mode": "deep",
  "reasoning_effort": "medium",
  "response_length": "long",
  "verbosity": "summary",
  "streams": {
    "snapshot": "/v1/jobs/j-A0OiglyGQuI2",
    "events": "/v1/jobs/j-A0OiglyGQuI2/events"
  }
}
```

`reasoning_effort` is returned for transparency but cannot be set. It is derived
from `mode`, so a caller cannot pair a cheap mode with an expensive thinking
budget.

---

## Jobs

### `GET /jobs`

Lists recent jobs, newest first. `?limit=` accepts 1 to 100 and defaults to 20.
Only jobs created through `/research` appear here; internal chat runs are not
listed.

### `GET /jobs/:id`

The job snapshot: status, live progress, and the final result when finished.

```json
{
  "job_id": "j-A0OiglyGQuI2",
  "query": "Which countries have digital nomad visas in 2026…",
  "mode": "deep",
  "reasoning_effort": "medium",
  "response_length": "long",
  "verbosity": "detailed",
  "status": "running",
  "created_at": "2026-10-01T06:12:04.221Z",
  "updated_at": "2026-10-01T06:14:51.880Z",
  "started_at": "2026-10-01T06:12:04.240Z",
  "finished_at": null,
  "progress": {
    "round": 12,
    "budget": {
      "used_steps": 12,
      "used_search_calls": 18,
      "used_fetch_calls": 7,
      "used_billable_tokens": 41280,
      "elapsed_ms": 167204,
      "search_calls_limit": 120,
      "fetch_calls_limit": 120,
      "billable_tokens_limit": 1000000,
      "wall_clock_limit_ms": 5400000,
      "exhausted_by": null
    },
    "source_map": [
      { "source_index": 1, "title": "…", "url": "https://…", "domain": "…" }
    ]
  },
  "result": null,
  "error": null
}
```

`status` is one of `queued`, `running`, `paused`, `completed`, `failed`,
`cancelled`, `declined`. `exhausted_by` names the ceiling that stopped the run, or is `null`.

### `GET /jobs/:id/events`

Server-Sent Events. Events are replayable: send `Last-Event-ID` or `?after=N` to
resume from a sequence number, so a dropped connection does not lose progress.

```sh
curl -N https://your-host/v1/jobs/j-A0OiglyGQuI2/events \
  -H "Authorization: Bearer ath_..."
```

```
id: 42
event: progress_note
data: {"headline":"Verifying official income figures","body":"Estonia's ?4,500 net?","round":8}

id: 43
event: step
data: {"type":"webpage","query":"https://?","result_count":1,"duration_ms":812}
```

Event types: `status`, `step`, `progress`, `progress_note`, `sources`, `done`,
`error`. `progress` carries the runtime state (round, budget use);
`progress_note` carries a status note the model published with
`report_progress`. The server sends periodic heartbeats so proxies do not close
an idle stream. Internal prompt and context dumps are not exposed.

### `POST /jobs/:id/cancel`

Stops a running job and releases its concurrency slot. Returns the job snapshot.

### `POST /jobs/:id/pause`

Pauses a running job. The current state is written to a checkpoint first, so the
run can be continued. Returns `400 JOB_NOT_PAUSABLE` if the job is not running.

### `POST /jobs/:id/resume`

Continues a paused job from its checkpoint, including its plan, source
registry, and remaining budget. Returns `400 JOB_NOT_RESUMABLE` if the job is not
paused.

A job the model declines as a non-question ends as `declined` with the reason
on the status event. It is terminal like `cancelled`, and work done so far is
billed the same way.

---

## `GET /models`

Lists the models the server can route to, with the context window and pricing from
the local models.dev cache. `?provider=` narrows the list to one provider. A model
known not to support reasoning or tool calls is excluded from research routing.

## `GET /analytics`

Aggregate spend and usage. `?days=` accepts 1 to 90 and defaults to 7; the
response echoes it as `window_days` alongside `generated_at` and the totals.
Needs the admin key (below).

---

## Key management

Available only from the local network — remote deployments return
`403 LOCAL_MANAGEMENT_ONLY`. Local alone is not enough: every request also
needs the admin key in the `X-Admin-Key` header, otherwise `401 UNAUTHORIZED`.
The key is generated on first boot and printed once to the server log;
override it with `ATHENA_ADMIN_KEY`, show it with `athena admin-key show`,
replace it with `athena admin-key rotate`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/keys` | List keys. Never returns secrets |
| `POST` | `/keys` | Create a key. `{ "name", "plan" }` where plan is `free`, `paid`, or `enterprise` |
| `DELETE` | `/keys/:id` | Revoke a key |

The secret is returned once, in the create response, and stored hashed. It cannot
be retrieved afterwards.

---

## Research controls

Three axes, all independent. Choosing one does not constrain the others.

### `mode` — how much research

The single effort axis. It sets the ceilings in `config.modes` and the reasoning
effort, and there is no second selector.

| `mode` | Reasoning effort | Search | Fetch | Billable tokens | Wall clock | Use |
|---|---|---|---|---|---|---|
| `instant` | `none` | 15 | 15 | 200K | 5 min | A quick factual pass |
| `default` | `low` | 40 | 40 | 600K | 20 min | Balanced (default) |
| `deep` | `medium` | 120 | 120 | 1M | 90 min | Cross-checking, larger ceiling |
| `max` | `xhigh` | 400 | 400 | 10M | 4 h | Exhaustive coverage |

Cache reads are excluded from the billable ceiling: they re-read a prefix the
provider already holds. The context is bounded by the model's own window, not by
this number.

### `response_length` — how long the answer

Sets the shape of the answer, not the amount of research.

| `response_length` | The answer |
|---|---|
| `short` | The conclusion, the reasoning behind it, and the one thing worth watching for. The main points rather than every point |
| `long` | The default. The conclusion, then the evidence behind it: every figure carries the source that confirms it, differences are explained, thin evidence is named as thin, and the reader is walked through the main points one by one |
| `exhaustive` | The whole research, laid out so a reader can navigate and check it. Every finding gets its own section, the sources that failed to settle the question are included, and every gap is named with what was tried |

Each length says what to write, not what to avoid. None of them forbids a table
or a heading; the shorter answers simply have less to lay out.

The definition of the requested length is appended to the system prompt. Only
that one definition is sent, so a run asked for `long` never reads what
`exhaustive` means.

### `verbosity` — what the caller sees

Does not change the answer at all.

| `verbosity` | Progress note | Raw reasoning |
|---|---|---|
| `summary` | shown | omitted |
| `detailed` | shown | shown, verbatim |

Diagnostics are unaffected: the trace and live log always record reasoning,
whatever the verbosity.

You can ask for a `short` answer shown at `detailed`, or an `exhaustive` answer
shown as `summary`.

---

## Research result contract

The `result` object on a completed job.

```json
{
  "query": "Which countries have digital nomad visas in 2026…",
  "answer": "As of late 2026 at least 37–59 countries and territories operate…",
  "sources": [
    {
      "source_index": 1,
      "title": "Digital Nomad Visa",
      "url": "https://www.e-resident.gov.ee/nomadvisa",
      "domain": "e-resident.gov.ee",
      "snippet": "…",
      "date": null
    }
  ],
  "steps": [
    { "type": "search", "query": "digital nomad visa 2026 list", "result_count": 8 },
    { "type": "webpage", "query": "https://…", "result_count": 1, "duration_ms": 812 }
  ],
  "results_count": 122,
  "elapsed_ms": 167204,
  "mode": "deep",
  "reasoning_effort": "medium",
  "verbosity": "detailed",
  "research_budget": { "used_steps": 21, "exhausted_by": null },
  "report": {
    "format": "athena.research.v1",
    "question": "Which countries have digital nomad visas in 2026…",
    "mode": "deep",
    "reasoning_effort": "medium",
    "sections": [
      {
        "id": "income-requirements",
        "title": "Income Requirements by Country",
        "findings": [
          {
            "id": "f1",
            "text": "Spain requires 200% of SMI, about €2,849 per month for 2026.",
            "citations": ["s12", "s89"]
          }
        ]
      }
    ],
    "sources": [
      { "id": "s12", "url": "https://…", "title": "…", "domain": "…", "source_index": 12 }
    ],
    "gaps": [
      { "description": "No official income figure for Kenya", "attempted": ["immigration.go.ke"] }
    ],
    "summary": { "findings": 41, "citedFindings": 39, "sources": 122, "gaps": 2 }
  }
}
```

`answer` is prose with inline `[N]` citations, where `N` is a `source_index` in
`sources`. `report` is the structured form of the same content: findings carry
citation ids, and `gaps` names what could not be resolved. A claim you cannot
verify appears in `gaps`, not in `answer` as a fact.

---

## Progress notes

The agent publishes status updates with the `report_progress` tool. Each note is a
short headline and a paragraph saying what the evidence just showed, what is
still open, and what comes next.

Notes arrive two ways.

**As an event.** Subscribe to `/jobs/:id/events` and read `progress_note` events:

```json
{
  "headline": "Verifying official income figures",
  "body": "Estonia's €4,500 net requirement is confirmed on the government page. Two sources disagree on Malaysia, USD 5,000 against USD 6,000, so that stays open.",
  "round": 8
}
```

**On the job record.** `verbosity` decides what each step carries:

| `verbosity` | `note` | `reasoning` |
|---|---|---|
| `summary` | the model's status note | omitted |
| `detailed` | the model's status note | the model's reasoning, verbatim |

The two fields are never mixed: `note` is always the status text, `reasoning`
always the raw model output. The trace records every note regardless.

Notes are a progress channel only. They are never part of `answer`, they cost no
tokens, and they do not count against the job's budget.

---

## Billing

Credit plans, in short:

| Plan | Research jobs | Tokens |
|---|---|---|
| `free` | Low ceiling, small token budget | 600K |
| `paid` | Higher concurrency | 10M |
| `enterprise` | Unset ceilings | negotiated |

A job reserves a concurrency slot when it is created and releases it when it
finishes, fails, is cancelled, or is declined. Exceeding a plan limit returns
`429` with the limit named in `details`. Cache-read tokens are billed at a
fraction of a fresh input token and are not charged against the research ceiling.
