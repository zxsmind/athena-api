# Research Quality Gaps — Critical Prompt/Agent Issues

> This document captures systemic quality failures observed in the research agent, using a concrete case as the trigger. It exists so the team does not forget the actual problems and does not pretend small prompt tweaks will fix them.

---

## 1. Trigger Case: `zxsmind` person lookup (Deep LOW, 20 credits)

**User request:**  
> "zxsmind adlı kişi internette bulunuyor mu? herhangi bir hesabı, yazısı, paylaşımı görünüyor mu? araştır."

**Observed behavior, run 1:**
- Single query: `zxsmind`
- Serper returned results about the `Xmind` mind-mapping software.
- Agent concluded: "This is probably a typo for Xmind." No further searches.
- Agent asked the user for clarification and stopped.
- 19 of 20 credits unused.

**Observed behavior, run 2:**
- Four queries: `"zxsmind" social media`, `"zxsmind" -xmind`, `"zxsmind" user profile`, `"zxsmind" blog`
- Found links to Instagram, Steam, a domain, and an npm keyword-search page.
- Agent wrote a final answer without fetching any URL.
- Claimed the accounts "might not belong to the same person" but did not verify.
- 16 of 20 credits unused.

**Why this is unprofessional:** The agent either gives up after one search or produces a surface-level answer from snippets without verification. This is not research, it is lazy retrieval.

---

## 2. The Real Failure Is Not the Model

The model is capable. The failure is in **how the prompt and control flow define the agent's job**.

Current system behavior shows the agent treats the search tool as a **question-answering oracle**, not as an **iterative sampler** of the web. The agent does not know what "done" means.

---

## 3. Specific Systemic Defects

### 3.1. One search is treated as a definitive answer
- `SYSTEM_PROMPT` says: "After results arrive, if you have enough to answer confidently, stop and write the answer."
- In practice, the model is "confident" after one off-target result set and stops.
- The prompt has no strong, general principle that **negative or off-target results are a signal to reformulate**, not a signal to conclude non-existence or ask the user.

### 3.2. No enforced verification step
- `DEEP_SYSTEM_PROMPT` says "Use `fetch_url` when snippets are not enough" and "cross-verify."
- The agent does not fetch URLs for verification.
- The prompt never defines what "verify" means for a specific question, and it never *requires* verification before a final answer.
- Result: the agent answers from titles and snippets, which is unreliable for person/identity/account claims.

### 3.3. "Final answer readiness" is too easy to satisfy
- The criteria are: (a) no material gaps, (b) unresolvable gaps with two source strategies, (c) budget exhausted.
- The model decides gaps are resolved as soon as it has *any* evidence, even if that evidence is weak, unverified, or contradictory.
- There is no independent audit of whether the evidence actually answers the user's question.

### 3.4. The agent optimizes for stopping early
- Even with 20 credits, it uses 4 and quits.
- The phrase "Do not conserve credits when material gaps remain" is ignored because the model does not perceive gaps.
- The agent's internal success metric appears to be "produce a plausible answer with minimal work," not "produce a reliable answer."

### 3.5. Clarification is used as a lazy escape hatch
- The agent asks the user "Did you mean Xmind?" instead of trying harder.
- There is no clear rule that clarification is only appropriate after the budget is exhausted or after a reasonable investigation has failed.
- The agent uses "helpful clarification" to end the research early.

### 3.6. The prompt conflates "finding links" with "answering the question"
- For "does this person exist online?", the user wants a *verified* answer about a person, not a list of links with the same username.
- The agent does not distinguish between:
  - "Links with this username exist"
  - "These links belong to the same person"
  - "This person has a notable online presence"
- The agent answers the first one and pretends it answered the second.

---

## 4. What "Professional" Should Look Like

For the `zxsmind` case, a professional deep-research agent should:

1. Try multiple search formulations (exact phrase, platform-specific, with/without context terms).
2. Fetch the actual pages it claims exist (Instagram profile, Steam profile, npm package, domain page).
3. Extract verifiable details: bio, username, profile picture, links, content, dates, author metadata.
4. Cross-reference evidence to decide whether the same person controls the accounts or whether the evidence is insufficient to say.
5. If the answer is uncertain, say exactly what was verified and what was not, and why.
6. Use the budget proportionally to the question's difficulty. For a simple person lookup, 20 credits should easily allow fetching 6–10 pages and writing a verified answer.

---

## 5. Required Fixes (High-Level)

These are not "try adding one more sentence to the prompt." They are structural changes to the agent's reasoning and control flow.

1. **Define verification as a mandatory phase.** The agent must fetch sources before making claims that depend on them, especially for identity/account/existence questions.
2. **Tighten the "done" criteria.** The agent must not stop just because it found links. It must stop when the evidence actually answers the user's question, or when the budget is exhausted after a reasonable investigation.
3. **Make the search tool a sampler, not an oracle.** The prompt must explicitly state: if the results do not match the target, the query is wrong, not the user's premise.
4. **Restrict clarification to late-stage research.** The agent should not ask the user for clarification after one search.
5. **Add a self-audit step.** Before writing the final answer, the agent must check whether it answered each material requirement of the user's request and whether its evidence is verified.
6. **Consider tool/flow changes.** For example, a `verify` or `fetch` requirement tied to certain claim types (identity, existence, attribution) might be more reliable than relying solely on prompt text.

---

## 6. Open Questions

- Should the agent be forced to fetch at least one URL before making any claim that depends on a specific page/profile?
- Should the final answer readiness be gated by a tool or by the prompt alone?
- Is the current `maxSearchesPerRound: 4` / `maxFetchesPerRound: 2` per-round limit helping or hurting verification?
- Does the model follow the existing prompt rules at all, or do the rules need to be rewritten in a more imperative, step-by-step style?

---

## 7. Related Files

- `server/src/agent/prompts.ts` — system prompts
- `server/src/engine/types.ts` — tool descriptions
- `server/src/engine.ts` — research loop and final answer logic
- `server/src/engine/depth-presets.ts` — per-depth budget/round limits

---

*Recorded after the `zxsmind` case exposed the agent to stop after one search or to answer from unverified snippets.*
