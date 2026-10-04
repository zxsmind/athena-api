# ADR 0006 — Research progress is a sequenced SSE stream

**Status:** Adopted for v1 job events.

## Decision

Research jobs expose a snapshot and `GET /v1/jobs/:id/events`. Every event receives a monotonic sequence ID, and SSE accepts `Last-Event-ID` or `?after=` for replay. The stream exposes job status, steps, progress, source updates, final report, and errors; it omits raw model context.

## Consequences

The playground and external clients observe the same progress contract. Event history is still held in memory and trimmed by the existing per-job limit; durable replay across process restarts is a roadmap item.
