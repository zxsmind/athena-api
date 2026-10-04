# Domain and API concepts

## Search result

A `SearchResult` is one provider result: title, URL, snippet, date, and optional extracted content. Search results do not imply that a model judged their relevance or that their claims were verified. Search can return links only, snippets, or full extraction for at most ten pages.

## Fetched document

A fetched document contains a public URL, readable title/content, and SHA-256 digest. Page extraction is independent of the LLM. Individual URL failures are returned alongside successful documents.

## Research job

A `ResearchJobRecord` represents a long-running question. Its lifecycle is `queued → running phases → completed | failed | cancelled`; deep jobs may also be `paused` and resumed from checkpoints. The public API returns an opaque `job_id`, a current snapshot, and a sequenced event stream.

Job snapshots and sequenced events are stored in SQLite. On restart, a deep job with a checkpoint is restored in paused state and must be explicitly resumed; a job without a checkpoint is marked failed. Notebook content and checkpoint payloads remain files.

Research batch snapshots and item/event history are stored in the same database. An interrupted batch is marked failed rather than silently restarted.

## Budget profile and reasoning effort

These are independent controls.

| Public profile | Internal depth | Current purpose |
|---|---|---|
| `lean` | `low` | Smallest research ceiling |
| `standard` | `med` | Default balanced ceiling |
| `thorough` | `high` | Larger ceiling and more source checks |
| `exhaustive` | `ultra` | Largest current ceiling and deeper gap review |

`mode` is `standard | deep | deep-max`. When the request omits `budget_profile`, the mode default applies (`standard` → `standard`, `deep` → `thorough`, `deep-max` → `exhaustive`); the research depth resolver uses the same mapping, so there is no separate "default depth" setting. `reasoning_effort` is `low | medium | xhigh`; v1 Research defaults to `xhigh`. It is sent as an AI SDK provider option. There is no quick/instant mode; the retired chat UI files were removed. Search and Contents are model-free.

## Source and citation identity

Each source used by a research job has a one-based `source_index`, local to that job and returned in `sources`. In the legacy prose contract a model citation `[N]` means the source with `source_index = N`.

The v1 report contract replaces model-authored citation markers with server-owned evidence IDs. `ev_NNN` is derived from `source_index`, so `ev_001` is always that job's first source. A finding's `citation_ids` may only contain IDs in the job's registry; the server drops fabricated IDs and converts any finding left without valid evidence into an explicit `gap`. The model never selects a URL, title, or evidence ID.

## Model/provider

A provider is configured in `server/data/settings.json`; it carries credentials, endpoint URL, available model IDs, and Smart Routing policy. A catalog model can declare reasoning, tool-call, structured-output, attachment, context, output, and cost metadata. A known false `tool_call` or `reasoning` capability prevents the model from being selected for a route that requires it. Missing catalog metadata does not automatically disable a configured model.
