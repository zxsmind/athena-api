# Billing and metering

> **Status: implemented on 2026-09-30.** Plan limits, per-model token pricing,
> rate limits, and overspend behaviour below are live. Owning code:
> `server/src/application/meter.ts` (admission + charging),
> `server/src/engine/metering.ts` (pure charge calculation),
> `server/src/rate-limit.ts`, `server/src/api-platform-store.ts` (persistence).

## Key identity

Every API key gets a short, human-quotable public identifier in the form `B4cK60vpFS9`:
mixed case plus digits, 10 characters. This is the **public** key id used in
quotas, logs, and analytics. It is not the bearer secret.

- Secret: returned once at creation, stored only as a SHA-256 digest.
- Key id: unique, non-secret, safe to log and to show in a UI.
- Generation is collision-checked against existing rows, not assumed.
- Ambiguous characters (`I`, `O`, `L`, `l`) are excluded from the alphabet.

## Plans

Plans are presets selected per key at creation and carried on the key record.
One credit is one US dollar.

| Plan | Daily credits | Overrun allowed | RPS | RPM | Concurrent jobs | Billable tokens per job |
|---|---|---|---|---|---|---|
| `free` | 1 | 0.25 | 10 | 30 | 5 | 600,000 |
| `paid` | 50 | 1 | 60 | 200 | 20 | 10,000,000 |
| `enterprise` | 500 | 5 | unlimited | unlimited | 100 | none |

Limits live in `server/src/config/defaults.ts` and are overridable per plan from
`config.yaml` in the data directory.

### Per-job token ceiling

A job's billable token ceiling is the **lower** of its plan's
`maxBillableTokensPerJob` and the mode's `maxBillableTokens`. The two protect
different things:

- the **mode** ceiling is a product decision: a mode stops when more spending no
  longer buys a better answer.
- the **plan** ceiling is a cost decision: a cheap plan cannot buy an expensive
  run just by asking for it.

`enterprise` sets its plan ceiling to null, so the mode's own limit applies.

## Metering rules

| Operation | Metered as |
|---|---|
| `POST /v1/search` | 0.007 credits per request |
| `POST /v1/contents` | 0.001 credits per successfully extracted page |
| `POST /v1/research` | per-model token cost + 0.007 per search + 0.001 per page read + 0.0001 per sandbox execution second (code engine only) |

Only work that actually succeeded is charged: a request that fails with `5xx`
before producing results does not debit the key.

## Token accounting

**Real token consumption only.** Usage comes from the provider response through
the AI SDK, never estimated.

- `LLMUsage` carries `inputTokens`, `outputTokens`, `cacheReadTokens`,
  `cacheWriteTokens` and `reported`.
- The engine keeps a per-model ledger (`BudgetState.tokenLedger`), so a job that
  uses two models prices each at its own rate.
- `reported` is false when the provider sent no usage. Such a call contributes
  nothing to the ledger, so nothing is invented for it.

### Billable versus total

Two numbers are tracked, because they answer different questions:

| | |
|---|---|
| `used_total_tokens` | Everything the provider processed, cache reads included. What a cost view shows. |
| `used_tokens` | What the job is charged against its ceiling: total minus cache reads. |

Cache reads are excluded from the ceiling. They re-read a prefix the provider
already holds and are priced at a fraction of a fresh input token, so charging
them at face value stopped long runs for work they did not pay for. They are
still recorded per model in the ledger, so billing sees the real cost.

`BudgetSnapshot` reports both, and the ceiling that stops a job is
`used_tokens`.

### Token prices

Prices are **per model, from the models.dev catalog** (`getCachedModelTokenPrice`).
The catalog publishes US dollars per one million tokens for `input`, `output`,
`cache_read` and `cache_write`; `engine/metering.ts` divides by one million when
converting to credits.

There is deliberately **no configurable flat token rate**. A single rate would be
wrong by orders of magnitude across models.

If the catalog has no price for a model, that model goes into the charge's
`unpricedModels` list, its tokens are **not** billed, and the server logs a
`[metering] no catalog price for ...` warning. The price gap is visible rather
than silently charged at a guessed rate.

## Overrun and exhaustion

A running job is never interrupted by a budget decision. When a job reaches a
terminal state it is billed from its own counters, and the daily balance may go
negative down to the plan's overrun allowance. The next request from that key is
refused with `429 BUDGET_EXHAUSTED` until the next UTC day.

A concurrency slot taken at job creation is released when the job reaches a
terminal state, including on billing failure, so a slot is never leaked.

## Metered requests

A presented key is always metered, whatever the source address. A loopback
request that presents no key is treated as local management and is not metered.

Rate limiting is in-memory and per process; it is only correct for a single
process deployment.

## Not yet decided

- Whether unused credits roll over.
- Refunds for failed or cancelled research jobs.
- Who reports plan usage to analytics.

## A note on token ceilings

The ceiling is a spend limit, not a context limit. A long job legitimately bills
far more than its largest prompt, because the conversation is re-sent every
round: five calls at 3K tokens costs roughly 3+6+9+12+15K. Nothing keeps that
bounded except the model's own window: there is currently no compaction layer,
so a long run can exhaust its budget or hit the provider's context limit before
it finishes.

This is the main open question in the billing model: if a future context layer
makes long runs much cheaper per finding, the current ceilings may be too
generous, and if they do not, they may be too tight. Neither is measurable until
that layer exists and long runs are observed end to end.
