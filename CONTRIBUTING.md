# Contributing

## Building and testing

The repository has two install roots. The server is its own package, and its
commands run from `server/`.

```sh
npm install
npm install --prefix server
npm run build --prefix server   # TypeScript, plus the local routing package
npm test  --prefix server       # vitest
npm run lint                    # from the repository root
```

All three are expected to pass before a change is finished. A change to dead-data
behaviour should also come with a test that fails without it.

## Where things live

| Path | Holds |
|---|---|
| `server/src/llm.ts` | Model transport: key rotation, retries, deadlines, provider options |
| `server/src/engine.ts` | The research loop: rounds, tool calls, budget ceilings |
| `server/src/engine/modes.ts` | Budget maths and the mode→effort rungs |
| `server/src/reasoning-effort.ts` | Pure rules for mapping a rung onto a model's vocabulary |
| `server/src/api-v1.ts` | REST routes and the MCP server |
| `server/src/models-dev.ts` | The models.dev catalog snapshot and its lookups |
| `docs/API.md` | The public contract for both transports |

Two files in the data directory are never committed: `settings.yaml` (secrets) and
`config.yaml` (tunables).

## Conventions

- Boundaries come from the caller, not from a fixed constant. If you are adding a
  timeout, the question is which caller knows the answer, not what number to
  choose.
- Prefer a measured value over a predicted one. Where a number is unavoidable, it
  should come from the data the system already holds, and the code should say
  where it came from.
- A change that can fail should say so in a way the reader can act on. Errors
  name the cause, not the layer that noticed it.
- Tests pin the behaviour, not the implementation. A test that only asserts a
  constant is a test that survives the constant changing.

## Commit messages

A subject line naming the area (`llm:`, `api:`, `mcp:`, `docs:`, `deps:`) followed
by the reason for the change, not a restatement of the diff. Where a decision was
a trade-off, say what was chosen and what was given up.

## Reporting a bug

Open an issue with the behaviour observed, the behaviour expected, and the
`job_id` or trace if the problem involved a research run. The trace records what
the model was sent, what it answered and what the provider returned, which is
usually the whole answer; enable it with `logging.trace` in `config.yaml`.
