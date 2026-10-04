# Athena documentation

These files describe Athena 002 after the research API migration. `API.md` is the public HTTP contract; `ARCHITECTURE.md` and `DOMAIN.md` own implementation boundaries and domain terms; `RESEARCHER.md` is the user-facing research/citation contract.

## Read by task

- API usage, authentication, inputs, responses, citations: [API.md](API.md)
- Runtime boundaries, providers, storage, and change ownership: [ARCHITECTURE.md](ARCHITECTURE.md)
- Search, research jobs, source indices, budgets, and reasoning: [DOMAIN.md](DOMAIN.md)
- Research behavior and model prompt source: [RESEARCHER.md](RESEARCHER.md)
- Quality measures and evidence thresholds: [EVAL.md](EVAL.md)
- Current phases and operational limits: [ROADMAP.md](ROADMAP.md)
- Latest project state and open verification work: [HANDOFF.md](HANDOFF.md)
- Accepted architectural decisions: [adr/README.md](adr/README.md)
- Key plans, daily credit budgets, per-model token pricing, and metering rules: [BILLING-PLAN.md](BILLING-PLAN.md)

## Migration from Athena 001

The useful 001 material was consolidated into these canonical documents:

| Athena 001 | Athena 002 owner |
|---|---|
| `docs/API.md` | `API.md` |
| `docs/ARCHITECTURE.md` | `ARCHITECTURE.md` |
| `docs/DOMAIN.md` | `DOMAIN.md` |
| `docs/RESEARCHER.md` | `RESEARCHER.md` |
| `docs/EVAL.md` | `EVAL.md` |
| `docs/ROADMAP.md` | `ROADMAP.md` |
| `docs/HANDOFF.md` | `HANDOFF.md` |
| ADR 0001–0007, 0009–0011, 0013, 0016–0017 | selected and reconciled in `adr/` |

## Historical records

These describe systems that no longer exist — the chat agent, the React frontend, the settings modal, and the pre-migration depth presets. Each carries a header saying so. They are not the current API or architecture authority; follow the files linked above when they disagree.

- `agent-strategy.md` — chat agent design
- `engine-root-cause-fix-plan.md` — original chat engine investigation
- `deep-depth-presets-plan.md` — the removed `depth-presets.ts` and `researchDepths`
- `settings-modal-redesign-plan.md` — the removed settings UI
- `smart-routing-integration-plan.md` — the pre-AI-SDK transport design
- `deep-mode-teşhis-raporu.md`, `sohbet-özeti.md` — dated 001 notes
