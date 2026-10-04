# ADR 0002 — Research ceilings and model reasoning are separate

**Status:** Adopted for `/v1/research`.

## Decision

`budget_profile` controls code-enforced research work limits. `reasoning_effort` (`low | medium | xhigh`) controls the selected model through AI SDK provider options. V1 defaults reasoning to `xhigh`; when `budget_profile` is omitted the mode default applies (`standard` → `standard`, `deep` → `thorough`, `deep-max` → `exhaustive`).

The public budget profiles map to existing 002 research depth presets: `lean → low`, `standard → med`, `thorough → high`, and `exhaustive → ultra`. There is no quick/instant mode.

## Consequences

Reducing searches/rounds does not disable model reasoning. Increasing reasoning does not raise code ceilings. The API and final report return both resolved controls so a caller can see what ran.
