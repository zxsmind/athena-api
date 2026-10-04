# ADR 0001 — Retrieval primitives are separate from research jobs

**Status:** Adopted for `/v1`.

## Decision

`POST /v1/search` and `POST /v1/contents` do not call a model. `POST /v1/research` creates a background job that uses those retrieval operations. A caller that wants links or extracted pages does not pay for or wait on an agent loop.

## Consequences

Search diagnostics can be measured independently from answer quality. Research tools reuse the same provider and extraction functions as direct API callers. The old unversioned `/search` route remains for the chat UI and is not the v1 contract.
