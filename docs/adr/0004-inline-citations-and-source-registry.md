# ADR 0004 — The model writes inline citations; Athena owns link resolution

**Status:** Adopted.

## Decision

The model writes the natural-language research answer and inline `[N]` markers. Each job assigns a one-based `source_index` to results returned by search/contents and returns the same source list with the answer. The UI turns a valid marker into the source link at that index.

Before the final report is emitted, Athena drops marker numbers outside the job registry and removes raw/Markdown URLs not present in the registry. It does not replace the model answer with a separately generated structured report.

## Consequences

Citation destinations cannot be invented independently from the API's source records, and users get ordinary readable prose. This is provenance validation, not semantic entailment: a real source can still be a poor support for a sentence, so faithfulness remains an evaluation target.
