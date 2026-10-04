# Brief: the status note works in isolation but not in the real prompt

Hand this together with `docs/PROMPTS.md`. `docs/PROMPTS.md` holds the exact
current system prompt, byte-identical to what the server sends, 9,649
characters. This file holds everything else.

This supersedes two earlier versions. Section 6 is the full measured record.

## 1. What we want

While researching, the agent should periodically write a status note in its
user-visible text: a bold headline of two to four words, a genuinely empty line,
then one paragraph of two to four sentences saying what it just learned, what is
still open, and what it will do next.

A note we would accept, from an isolated test:

```
**Checking current requirements**

I'm cross-checking the income thresholds for the major digital nomad visa
programs since they change frequently and some early results conflict.
```

Requirements, as agreed:

- Two to four words, bold, then a real empty line, then one paragraph.
- In the language of the request.
- Roughly every two to four turns.
- Paragraph must carry substance: a figure, a source conflict, a dead end. Not
  "let me search more".
- Never in the final answer.

**Hard constraint: no worked example in the system prompt.** An example
conditions the model into copying it. The prompt states the shape in general
terms only. A prompt test forbids `For example` and `such as **` in the body.

## 2. Setup

- `qwen3.8-27b` at `https://api.sovinfra.ai/v1`, via `@ai-sdk/openai-compatible`.
- Reasoning and tool calls arrive in the same response. This is normal.
- Full runs: 15 to 30 tool calls each.
- Isolated probes: 5 turns, single `web_search` tool, canned results containing
  real figures, one source conflict, one HTTP 403, and one dead end, so a note
  claiming substance has something to report.
- Full runs all used one question: which countries have digital nomad visas as of
  2026, the income requirement for each, and the primary sources confirming them.

## 3. Two real bugs found and fixed

Neither was a prompt problem. Both fixed.

1. **We dropped the model's reasoning.** `engineResponse()` in
   `server/src/llm.ts` built a message object with only `role` and `content`,
   never writing a `reasoning` field. The engine's step event, the JSONL trace,
   and the live log all read that object rather than the raw provider body, so
   reasoning was invisible in all three. `callSelectedTarget()` also never read
   `result.reasoningText`. Reasoning now appears in 24 of 24 responses where it
   previously appeared in none.

2. **The notebook manifest was injected every round** as a trailing user
   message. Removed.

Before fix 1 the live log printed `(none)` for reasoning on every turn, which
reads exactly like a model that does not reason. **Any measurement taken before
that fix is invalid.**

## 4. What the model actually does

It narrates on every single turn into the reasoning channel. In one run 24 of 24
responses carried reasoning, 2 carried text. Samples:

| Turn | Reasoning |
|---|---|
| 40 | `I'm seeing some conflicting information about Spain's 2026 minimum wage...` |
| 47 | `I'm working through the Spain SMI 2026 calculation - there's a discrepancy...` |
| 76 | `I've confirmed Japan's official income requirement of 10 million yen a...` |

That is the content we asked for, without the formatting.

## 5. The conflicts we found in the prompt

**Conflict 1, the one that mattered.** `research-api-prompt.ts` line 10, line 3
of the assembled prompt, said unscoped:

> Do not answer from model memory and do not add greetings, first-person
> narration, or conversational filler. Return the answer itself.

The progress rule sits 30 lines later and asks for narration. Because the
output contract is at the top of the prompt and its ban was unscoped, it won.
Now scoped: `in the final answer do not add greetings...`.

**Conflict 2, the heading.** Format said `do not add decorative markdown` and
`A short answer gets no headings at all`, both unscoped, forbidding a bold
headline. Now scoped to the answer, with the note named as the exception.

Attempts 1 to 3 chased conflict 2. Attempt 4 fixed conflict 1 and produced the
first bold headline.

**Still unscoped, and a candidate for a third conflict.** In the same identity
block:

> A research request is not a chat turn: it is a request to investigate and
> return findings.

and:

> Lead with the directly requested deliverable — the specific answer, value, or
> list — in the first lines.

Neither is scoped to the final answer. `Return the answer itself.` remains
global even after attempt 4. We have not changed these.

**Competing sinks.** Three places in the prompt ask for the same information,
what was found, what is open, what is next:

| Sink | Prompt wording |
|---|---|
| reasoning | natural to Qwen, used every turn |
| `write_notebook` | "what changed, the URLs that support it, open gaps, and the next search to try" |
| visible note | "what you just learned, what is still open, what you will do next" |

The model already uses the first two. We ask it to repeat the same content a
third time.

## 6. The measured record

### Full runs, one question each

| # | Change | Tool calls | Notes | Bold headline |
|---|---|---|---|---|
| 1 | New rule: "with every tool call, include a short status note" | 20 | 3 | 0 |
| 2 | Reworded, dropped the per-tool-call demand | 17 | 3 | 0 |
| 3 | Scoped the Format rules to the answer | 23 | 1 | 0 |
| 4 | Scoped the identity block to the final answer, and bound the note to the visible text channel | 16 | 2 | **1** |
| 5 | Changed cadence to "every two to four turns" | 17 | 2 | 1 |
| 6 | Asked for a blank line between headline and paragraph | 17 | 2 | 1 |
| 7 | Added "the note is the whole of your visible text", and told Step 0 to be silent | 21 | 2 | **0** |

Counting notes as a percentage of tool calls is the wrong metric once the rule
says "every few turns". Three notes across 17 tool calls is roughly the cadence
asked for. **Frequency has never been the failing dimension.** The failures are
that notes are rare rather than absent-but-malformed, and that the format is
inconsistent.

Attempt 7 is the most informative row. Attempt 4's wording was short. Attempt 7
added two prohibitions, to Step 0 and to the note rule. Result: zero bold
headlines, and the notes that appeared came back with a preamble attached:

```
I'll research this systematically. This is an evolving, multi-country question
where I need to distinguish genuine dedicated "digital nomad" visas from
general long-stay visas...

**Setting up the research plan**

This is a broad, multi-part question. I'll break it into evidence needs: (1)...
```

The preamble is Step 0 leaking into visible text; the model's reasoning shows it
had already done Step 0 and wrote it twice. Adding the prohibition made it worse
by attaching a justifying clause. Those two additions are reverted and a test
now asserts they stay reverted.

### Isolated probes, 5 turns each, real prompt vs short prompt

Same endpoint, model, `reasoning_effort`, and tool schema throughout. Only the
system prompt differs.

| Probe | System prompt | Text | Bold + blank line |
|---|---|---|---|
| 1 | our real prompt, abbreviated | 0/4 | 0 |
| 2 | channel split, no format | 2/5 | 0 |
| b | channel + format | 1/4 | 0 |
| c | channel + format + "do not narrate in reasoning" | 2/5 | 1 |
| **e** | **channel + format, note in the same response as the tool call** | **2/4** | **2/2** |
| i | same as e, but the separator written as the literal characters `\n\n` | 0/3 | — |
| j | same as i, plus a gloss that `\n\n` means two newlines | 0/5 | — |
| g | like e, plus "a note that only says what you are about to do is worthless" | **0/5** | 0 |
| h | like g, but the three required elements named one by one | 1/3 | 0 |

Variant e produced exactly the requested shape, on the turn that produced it:

```
**Checking current requirements**

I'm cross-checking the income thresholds for the major digital nomad visa
programs since they change frequently and some early results conflict.
```

and, on another turn:

```
**Verifying country-specific figures**

The initial results were thin, so I'm digging into individual programs to pin
down accurate monthly or annual income thresholds.
```

## 7. What the record shows

**The engine is not at fault.** Raw SSE from our own prompt shows
`delta.content` empty on every turn and `reasoning_content` populated on every
turn. Nothing is dropped in transit. This was verified by bypassing the AI SDK
entirely and reading the provider's deltas directly.

**It is the prompt.** Identical requests, identical tools, a 250-character
system prompt produces the requested format; our 9,649-character one produces
it roughly once in seventeen turns.

**`\n\n` written literally into the prompt does not work.** Variants i and j
wrote the two characters into the instruction. Notes stopped entirely, 0/3 and
0/5. Describing the same thing as "a blank line" works, 2/2. Note also that the
prompt is a TypeScript template literal, so an unescaped `\n\n` would be
compiled into two real newlines before the model ever saw it; the probes wrote
the literal characters.

**Demand substance and the model stops writing notes.** Adding "let me search
more is not a note", variant g, gave 0/5 notes across five turns. The same run
with the substance clause reworded as a bar it must clear, variant h, gave 1/3.
When we demanded both format and substance at once, format gave way: variant e
with a substance clause produced 3 notes with real figures and zero correct
formats.

So the three requirements trade against each other. Format alone works.
Substance alone works. Asking for both loses one of them.

**Format plus substance plus cadence in one sentence does not hold.** The
prompt currently asks for all three in the sentence beginning `Narrate as you
go.`

## 8. Questions for you

1. Given that a 250-character system prompt gets the format and our 9,649
   character one does not, is the fix to shorten the prompt, to move the note
   rule higher, or to move it out of the prompt entirely?
2. The identity block still tells the model "not a chat turn", "return the answer
   itself", and "lead with the deliverable in the first lines", none scoped to
   the final answer. We have not touched these. Does scoping them, as you
   suggested earlier, matter, and which of the three?
3. The notebook asks for what changed, open gaps, next search. The note asks for
   what was learned, what is open, what is next. Should the notebook rule be
   narrowed so it stops competing, and if so how?
4. Given the trade in section 7 between format and substance, and given that
   variant g showed harsh wording silences the model entirely, how would you
   word it?
5. Would you accept a dedicated `report_progress` tool taking `headline` and
   `body`, where the engine publishes the call to the user as a progress event
   and format and cadence become engine guarantees rather than model behaviour?
   If so, how should it interact with compaction, resume, and the existing step
   events?

Constraints on any answer:

- No worked example in the prompt.
- English only.
- Nothing added that duplicates a rule stated elsewhere.
- The language rule is stated exactly once in the whole prompt.
- Adding prohibitions has twice made this worse. Weigh any new instruction
  against that.

## 9. Rules that must survive any edit

Covered by tests in `server/tests/research-prompt.test.ts`.

- The identity block scopes its ban: `in the final answer do not add greetings`.
- `A status note is output, not thought: it belongs in visible response text,
  never in reasoning.`
- `emit a user-visible status note in your normal assistant text, outside your
  reasoning`
- `Every two to four turns`
- `then leave a blank line and one paragraph below it`
- `Keep emphasis minimal **in the answer.**` with the note as the named
  exception.
- `This governs the answer; the bold headline on a progress note is not a
  heading.`
- Step 0 stays unscoped, and the note rule does not claim the whole visible
  text. Both regressed when changed and are asserted against.
- No `For example`, no `such as **`.
- Answer-format rules remain: prose by default, a table only for genuinely
  tabular content, a synthesis paragraph after any table, uncertainty woven into
  prose rather than a disclaimer block.

## 10. Files

| Path | Contents |
|---|---|
| `docs/PROMPTS.md` | The exact prompt, byte-identical to the server, plus tool definitions |
| `server/src/agent/prompts.ts` | Prompt body. Note rule line 42, scoped format rules lines 68 and 70 |
| `server/src/agent/research-api-prompt.ts` | Identity block, line 10, prepended to the prompt |
| `server/src/llm.ts` | `engineResponse()` and `callSelectedTarget()`, where reasoning was dropped |
| `server/src/engine.ts` | `stepContentForVerbosity()`, which decides what a step shows |
| `server/tests/research-prompt.test.ts` | Prompt contract tests, including the attempt 7 regression |
| `server/live.mts` | Live runner: `npx tsx live.mts "<question>" deep detailed` |
| `%LOCALAPPDATA%\athena\traces\<job>.live.log` | Full-fidelity log: every prompt and response, reasoning included |
| `%LOCALAPPDATA%\athena\traces\<job>.jsonl` | Structured trace |

To reproduce a full run: run the live script, then read the `--- TEXT ---` and
`--- REASONING ---` sections of each `LLM OUTPUT` block in the live log.
Reasoning appears there only after the fix in section 3.

The isolated probes in section 6 were written to read the provider's raw SSE
deltas directly, bypassing the AI SDK. That is how the pipeline was cleared of
fault in section 7.