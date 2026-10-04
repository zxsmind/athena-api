# Agent Architecture v2 — Research Protocol

> **Current status (2026-09-30):** This is a historical design plan for the chat agent. The v1 Research API prompt and citation contract are now owned by [`RESEARCHER.md`](RESEARCHER.md) and `server/src/agent/research-api-prompt.ts`; use [`ARCHITECTURE.md`](ARCHITECTURE.md) for current runtime boundaries.

## Current Problems Recap

1. No planning phase → model makes ad-hoc search queries
2. No analysis phase → model doesn't evaluate result quality
3. Single `web_search` tool → no separation of concerns
4. Temperature=0 throughout → no strategic thinking
5. Soft system prompt → model treats rules as suggestions
6. No gap analysis in deep mode → fake "deep research"

## Core Principle

The agent follows a strict research protocol with explicit phases. Each phase is a dedicated model call with its own prompt, temperature, and tool set. The model cannot skip phases.

```
USER QUERY
    │
    ▼
┌─────────────────────────┐
│  PHASE 1: PLAN          │  temperature=0.3
│  • Analyze query        │  tools = [web_search] but NOT called
│  • Identify sub-questions│  output: structured plan
│  • Generate 3-5 queries │
└─────────┬───────────────┘
          │ plan JSON
          ▼
┌─────────────────────────┐
│  PHASE 2: SEARCH        │  parallel execution
│  • Execute ALL queries  │  no model call
│  • Collect results      │
└─────────┬───────────────┘
          │ raw results
          ▼
┌─────────────────────────┐
│  PHASE 3: ANALYZE       │  temperature=0.1
│  • What did we find?    │  tools = [web_search]
│  • What's missing?      │  → can request more searches
│  • Contradictions?      │
│  • NEW queries needed?  │
└─────────┬───────────────┘
          │  need more? ──yes──▶ PHASE 2 (loop max 2x)
          │  no
          ▼
┌─────────────────────────┐
│  PHASE 4: SYNTHESIZE    │  temperature=0
│  • Write final answer   │  stream=true
│  • Cite [N]             │
│  • Note uncertainties   │
└─────────┬───────────────┘
          │ final answer
          ▼
        DONE
```

## Phase Details

### Phase 1: Plan

**System prompt excerpt:**
```
You are a research planner. Your ONLY job is to analyze the user's question
and produce a research plan. Do NOT answer the question. Do NOT use any tools.

Analyze the question. Break it into 2-5 search queries that cover:
1. Core factual claims needed
2. Different angles/perspectives
3. Any sub-questions implied

Output a JSON object:
{
  "analysis": "Brief analysis of what the question requires",
  "queries": ["query1", "query2", ...],
  "sub_questions": ["What is X?", "How does Y work?"]
}
```

**Temperature:** 0.3 (allows strategic thinking, still focused)
**Tools:** NONE (prevent premature searching)

### Phase 2: Search

**No model call.** Pure execution:
- Take queries from Phase 1
- Run `Promise.all(fetchResults(q))`
- Attach `source_index` to each result
- Return deduplicated source map + tool messages

### Phase 3: Analyze

**System prompt excerpt:**
```
You are a research analyst. Your job is to evaluate the search results
and determine if more information is needed.

Review each source critically:
- Does it directly address the question?
- Is the source authoritative?
- Are there contradictions between sources?
- What important aspect is still unanswered?

If you need more information, use web_search to find it.
Otherwise, output: {"satisfied": true, "summary": "Brief summary of findings"}

If you need more searches, use web_search with specific, targeted queries.
After web_search results come back, re-evaluate.
```

**Temperature:** 0.1
**Tools:** `web_search` (for targeted follow-ups)
**Max rounds:** 2 (analyze → search → analyze → exit)

### Phase 4: Synthesize

**System prompt excerpt:** (same as current evidence-first prompt)
- Strict `[N]` citation rules
- No "Sources" section
- Same language as user
- Stream output

**Temperature:** 0
**Tools:** none (forced `tool_choice: 'none'`)
**Stream:** true

## Tool Set

```typescript
// Phase 3 only
web_search(search_query: string)
```

One tool only, used only in Phase 3 for gap-filling. Phase 1 cannot use it.

## Quality Gates

| Gate | Check | Action if fails |
|------|-------|----------------|
| Plan parsing | Valid JSON? `queries[]` length ≥ 1? | Retry Phase 1 once |
| Search results | Any results returned? | Log warning, continue |
| Analysis decision | `satisfied: true` or tool_call? | Force-satisfy after 2 rounds |
| Token count | < 3200? | Trim messages if 413 |
| Sources empty | `allSources.size === 0` | Inject "no results" note into prompt |

## Deep Research Mode Enhancement

Instead of the current ad-hoc gap analysis:

```
Phase 1 → Phase 2 → Phase 3 → Phase 3.5 → Phase 4
                                    │
                            ┌───────┴────────┐
                            │  Phase 3.5:     │
                            │  Critical Review│
                            │  • Expert review│
                            │    of findings  │
                            │  • Generate 3   │
                            │    follow-up    │
                            │    queries      │
                            └───────┬────────┘
                                    │ queries
                                    ▼
                              Phase 2 (loop)
                                    │
                                    ▼
                              Phase 3 (re-analyze)
                                    │
                                    ▼
                              Phase 4 (synthesize)
```

Phase 3.5: temperature=0.3, no tools. Prompt:
```
You have gathered information and analyzed it. Now act as a critical reviewer.
What weak spots remain? What perspectives are missing? What claims need
verification from additional sources?

Output a JSON object:
{
  "review": "Critical assessment of current knowledge",
  "follow_up_queries": ["query1", "query2", "query3"]
}
```

## Implementation Plan

1. **`src/agent/types.ts`** — Shared types: `ResearchPlan`, `AnalysisResult`, `ReviewResult`, `Phase` enum
2. **`src/agent/prompts.ts`** — All system prompts in one place
3. **`src/agent/planner.ts`** — Phase 1: plan extraction
4. **`src/agent/searcher.ts`** — Phase 2: search execution + source indexing
5. **`src/agent/analyst.ts`** — Phase 3: analyze + decide (tool-calling loop)
6. **`src/agent/reviewer.ts`** — Phase 3.5: critical review (deep mode only)
7. **`src/agent/synthesizer.ts`** — Phase 4: streaming final answer
8. **`src/engine.ts`** — Orchestrator: wires phases together, SSE events, error handling

## Backward Compatibility

- SSE event types unchanged (`step`, `token`, `done`, `error`)
- `SearchResponse`, `Source`, `AgentStep` schemas unchanged
- `agenticResearchStream` signature unchanged
- New `AgentStep` types: `plan`, `analyze`, `review` added alongside existing ones
