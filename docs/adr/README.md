# Architecture decisions

These decisions replace the directly relevant Athena 001 ADRs after adapting them to the existing Athena 002 codebase. They describe adopted boundaries and the current limits; they do not claim that deferred production-hardening work is complete.

| ADR | Decision |
|---|---|
| 0001 | Separate retrieval primitives from model-driven research |
| 0002 | Budget profiles and model reasoning are independent |
| 0003 | AI SDK transport plus models.dev capability data |
| 0004 | Model-written inline citations resolve through a per-job source registry |
| 0005 | Client keys and API analytics are local persistent records |
| 0006 | Research jobs expose replayable sequenced SSE |
| 0007 | Research quality claims require evaluation evidence |

The old ADRs about Effect, narration, visual/browser modes, and build-enforced architecture were not copied as accepted decisions: those choices either conflict with the current product direction or are not implemented in this repository.
