# Documentation

The documents below describe Athena as it is today, plus one active plan.
Everything else in `archive/` is a
historical plan or report kept for context and is **not** a description of the
current system.

| Document | Covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the system fits together, and what it cannot do yet |
| [API.md](API.md) | The public HTTP contract |
| [PROMPTS.md](PROMPTS.md) | Exact prompt text and tool schemas |
| [BILLING-PLAN.md](BILLING-PLAN.md) | Plans, credits, and metering |
| [CODE-EXECUTION-PLAN.md](CODE-EXECUTION-PLAN.md) | Proposed code-execution research harness; not built yet |

`../AGENTS.md` is the working agreement for coding agents: the rules that are not
obvious from the code.

## archive/

Plans, root-cause analyses, handoff notes, and evaluation drafts from earlier
work. Several describe a React frontend and a settings modal that no longer exist
in this repository, and modes that were renamed. They are kept because the
reasoning behind past decisions is sometimes worth recovering, not because they
are accurate.

If you are about to act on something you read in `archive/`, verify it against
the code first.