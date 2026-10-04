import { describe, expect, it } from 'vitest';
import { getApiResearchSystemPrompt, API_RESEARCH_IDENTITY } from '../src/agent/research-api-prompt.js';
import { responseLengthBlock } from '../src/agent/prompts.js';
import { getCodeSystemPrompt } from '../src/agent/code-prompt.js';
import { FETCH_URL_TOOL, MAX_URLS_PER_FETCH_CALL, READ_BUDGET_TOOL, RUN_CODE_TOOL, RUN_CODE_TOOL_NAME } from '../src/engine/types.js';
import { REPORT_PROGRESS_TOOL } from '../src/engine/progress.js';
import { modeBehaviorBlock, resolveResearchPreset, RESEARCH_MODES } from '../src/engine/modes.js';

const mode = (name: 'instant' | 'default' | 'deep' | 'max'): string =>
  modeBehaviorBlock(resolveResearchPreset(name));

const body = getApiResearchSystemPrompt(true);

describe('prompt structure', () => {
  it('puts the role contract first and the format section last', () => {
    expect(body.startsWith(API_RESEARCH_IDENTITY)).toBe(true);
    expect(body).toContain('## Evidence rules');
    expect(body).toContain('## Process');
    expect(body).toContain('## Stopping and uncertainty');
    expect(body).toContain('## Format');
    expect(body.indexOf('## Evidence rules')).toBeLessThan(body.indexOf('## Process'));
    expect(body.indexOf('## Stopping and uncertainty')).toBeLessThan(body.indexOf('## Format'));
  });

  it('scopes the no-narration rule to the final answer, so it cannot silence progress notes', () => {
    expect(API_RESEARCH_IDENTITY).toContain('in the final answer do not add greetings');
    /* An unscoped ban on narration contradicts the progress-note rule and wins,
       because the output contract sits at the top of the prompt. */
    expect(API_RESEARCH_IDENTITY).not.toMatch(/memory and do not add greetings, first-person narration/);
  });

  it('names the progress tool in prose, because the schema alone did not produce one call', () => {
    /* This replaced the previous rule, which required the prompt to say nothing
       about status notes on the grounds that report_progress owned the format,
       the cadence and the substance. Five live runs contradicted that: sixteen
       tool calls, zero of them report_progress, while create_plan, write_notebook
       and recall_source were all used. A tool the prompt never mentions is a
       tool whose purpose has to be inferred, and this one has no self-evident
       reason to exist next to web_search.

       What stays gone is the narration *rule* in the model's own text. The note
       is a tool call; the prose instruction is what failed eight times. */
    expect(body).not.toMatch(/Narrate as you go/);
    expect(body).not.toMatch(/A status note is output, not thought/);
    expect(body).toMatch(/Progress notes\./);
    /* The cadence is stated once, in the prompt, as well as in the schema. Two
       copies of one number would drift apart on the next edit. */
    expect(body).toMatch(/every two to four rounds of searching/);
    expect(REPORT_PROGRESS_TOOL.function.description).toMatch(/every two to four rounds of searching/);
    expect(body).not.toMatch(/Every two to four turns/);
    expect(API_RESEARCH_IDENTITY).toMatch(/progress notes you publish with report_progress, is written in the same language/);
  });

  it('tells the model what a note must carry, in terms of what it contains', () => {
    /* Phrased positively. Telling the model a lazy note is worthless silenced it
       entirely, five turns out of five. */
    expect(body).toMatch(/at least one fact of its own/);
    expect(body).toMatch(/in the language of the request/);
    expect(REPORT_PROGRESS_TOOL.function.parameters.properties.body.description).toMatch(/Two to four sentences/);
  });

  it('asks for the note to ride along with other tools, since a note alone costs a turn', () => {
    expect(body).toMatch(/in the same response as other tools/);
  });

  it('withholds the first note until results exist, because the count alone let a plan pass for one', () => {
    /* With only the every-two-to-four-rounds cadence, the model counted rounds
       rather than work: a measured run published at rounds 0, 2 and 4, and the
       note at round 0 was a statement of what it was about to do, published
       beside the search that had not returned yet. The reader watching a
       ninety-second gap was told a run was under way when nothing had come
       back. The test is now whether the note could have been written before the
       round it accompanies, which a plan always satisfies and a finding never
       does. */
    expect(body).toMatch(/due once results are in hand/);
    expect(body).toMatch(/describes work that has not returned yet/);
    expect(body).toMatch(/reporting a plan rather than a finding/);
  });

  it('fetches pages as a list, like it searches as a list', () => {
    /* A measured run issued eleven separate fetches, four of them in one
       response. The tool now takes urls[] with a cap, because the pages share
       one context and an unbounded list would return more text per turn than the
       model can read. */
    const fn = FETCH_URL_TOOL.function;
    expect(fn.name).toBe('fetch_url');
    expect(fn.parameters.required).toEqual(['urls']);
    const urls = fn.parameters.properties.urls as { type: string; maxItems: number };
    expect(urls.type).toBe('array');
    expect(urls.maxItems).toBe(MAX_URLS_PER_FETCH_CALL);
    expect(MAX_URLS_PER_FETCH_CALL).toBeGreaterThan(1);
    expect(MAX_URLS_PER_FETCH_CALL).toBeLessThanOrEqual(6);
  });

  it('names no notebook tool, because the notebook is gone', () => {
    /* The prompt used to carry a **Notebook.** section and a `notebookEnabled`
       flag that stripped it. Both are gone: the tool no longer exists, and a
       prompt naming it would send the model calling into an error message. */
    const body = getApiResearchSystemPrompt();
    expect(body).not.toContain('write_notebook');
    expect(body).not.toContain('read_notebook');
    expect(body).not.toContain('**Notebook.**');
    expect(body).toContain('## Evidence rules');
  });
});

describe('certainty follows evidence, not the effort profile', () => {
  it('states the rule explicitly', () => {
    expect(body).toContain('Confidence follows evidence, never the effort profile');
  });

  it('never instructs the model to drop hedging language', () => {
    for (const name of RESEARCH_MODES) {
      const block = mode(name as 'instant');
      expect(block).not.toMatch(/definitive fact|complete certainty|as definitive/i);
      expect(block).not.toMatch(/not "likely" or "estimated"/i);
    }
  });

  it('keeps the "say what is uncertain" floor in every mode', () => {
    expect(body).toMatch(/say what is supported, what is uncertain, and what could not be confirmed/);
  });
});

describe('verification standard is budget compatible', () => {
  it('sets a reachable floor of two sources and three for contested claims', () => {
    expect(body).toMatch(/Require 2 independent sources for a key claim, and 3 when the claim is contested/);
  });

  it('forbids a mode from lowering the floor', () => {
    expect(body).toMatch(/may never lower them/);
  });

  it('does not demand three fetched sources from the cheapest mode', () => {
    expect(mode('instant')).not.toMatch(/at least 3 independent/);
  });

  it('lets every mode acknowledge the wrap-up signal as a stopping condition', () => {
    for (const name of RESEARCH_MODES) {
      expect(mode(name as 'instant')).toMatch(/or when a wrap-up signal appears/);
    }
    expect(body).toMatch(/If a wrap-up signal appears, stop searching and write the answer/);
  });
});

describe('the record is the evidence for origin and attribution', () => {
  it('names the claims commentary cannot confirm, because a run asserted an origin from an article about it', () => {
    /* Measured: a run said where a meme came from, who first said it, and when,
       citing an encyclopedia page and a news article. The episode the claim was
       about was never fetched. Commentary repeating a claim is a cross-check,
       not the record. */
    expect(body).toMatch(/An origin, a first, an attribution, a quote, or the date of an event/);
    expect(body).toMatch(/confirmed by the record itself/);
    expect(body).toMatch(/not by articles, encyclopedias, listings, or posts that retell it/);
  });

  it('keeps a source the kind it is, because a video tag became an interview', () => {
    /* Measured: a run wrote that the creator confirmed the origin in an
       interview, citing a Reddit post and a video listing whose tag list
       contained the word "interviews". Neither was fetched, and neither is an
       interview. */
    expect(body).toMatch(/Keep each source the kind it is/);
    expect(body).toMatch(/a tag, a listing, or a retelling does not become an interview, a confirmation, or the record/);
  });

  it('says how to write a claim whose record could not be read', () => {
    /* A video record that cannot be read leaves the claim resting on coverage.
       The answer has to say so instead of asserting the claim as established. */
    expect(body).toMatch(/present the claim as reported, not as established/);
  });

  it('carries the mandate in the deep block, where the snippet rule lives', () => {
    /* The body states the rule; the mode block is the last instruction before
       the model's own reasoning. Two live runs still asserted an unfetched
       record as primary after the body alone was in place. */
    expect(mode('deep')).toMatch(/fetch the record itself/);
    expect(mode('deep')).toMatch(/when it cannot be read, say the claim rests on reports about it/);
  });
});

describe('gaps are reported rather than concealed', () => {
  it('forbids fabricating evidence to close a gap', () => {
    expect(body).toMatch(/Never fabricate evidence to close a gap/);
  });

  it('no longer forbids recording that a source was inaccessible', () => {
    expect(body).not.toMatch(/Never write a conclusion to stop/);
    expect(body).not.toMatch(/never whether to give up/i);
    expect(body).toMatch(/is not proof that the information does not exist/);
    /* The gap used to be recorded in the notebook; the notebook is gone, so
       "record it as an unresolved gap" no longer appears. The requirement that
       survives is reporting it in the final answer, asserted below. */
    expect(body).not.toMatch(/record it as an unresolved gap/);
  });

  it('requires an unresolved gap to be reported in the final answer', () => {
    expect(body).toMatch(/report it in the final answer/);
  });

  it('tells the model an uncited claim publishes as a gap, not a finding', () => {
    expect(body).toMatch(/reported to the reader as unverified/);
    expect(body).toMatch(/lands in the structured report as a gap rather than as a finding/);
  });
});

describe('rules are stated once', () => {
  it('does not repeat the citation rule', () => {
    const mentions = body.match(/Never invent a source number/g) ?? [];
    expect(mentions).toHaveLength(1);
  });

  it('does not repeat the untrusted-content rule', () => {
    const mentions = body.match(/untrusted/g) ?? [];
    expect(mentions.length).toBeLessThanOrEqual(1);
  });

  it('states the language rule once, covering the answer and the progress notes', () => {
    /* One rule, both user-visible surfaces. The phrase moved into the identity
       block when the note became a tool call. */
    const mentions = body.match(/in the user's language/g) ?? [];
    expect(mentions).toHaveLength(1);
    expect(API_RESEARCH_IDENTITY).toMatch(/Everything the user reads, both that answer and the progress notes/);
  });
});

describe('general principles instead of test cases', () => {
  it('states the qualifier rule without the wired/wireless example', () => {
    expect(body).toMatch(/Qualifiers of the main claim/);
    expect(body).not.toMatch(/wired/i);
  });

  it('states the extraction rule without naming a specific aggregator', () => {
    expect(body).toMatch(/If an authoritative source contains the complete requested content/);
    expect(body).not.toMatch(/\bwiki\b/i);
  });
});

describe('previously missing cases', () => {
  it('covers ambiguous questions', () => {
    expect(body).toMatch(/\*\*Ambiguous questions\.\*\*/);
  });

  it('covers opinion and recommendation requests', () => {
    expect(body).toMatch(/\*\*Opinion or recommendation requests\.\*\*/);
    expect(body).toMatch(/Do not deliver a personal verdict/);
  });

  it('states the response length rule in the body and sends one definition', () => {
    /* The rule stays in the prompt; only the requested definition travels, so a
       run asked for `long` never reads what `exhaustive` means. */
    expect(body).toMatch(/\*\*Response length\.\*\*/);
    expect(body).toMatch(/its definition is appended at the end of these instructions/);
    expect(body).toMatch(/Do not add evidence to reach a length/);
    expect(body).toMatch(/do not cut a claim you gathered to fit one/);
    /* None of the three labels is spelled out in the body any more. */
    expect(body).not.toMatch(/is enough to act on/);
    expect(body).not.toMatch(/is the default and is what most requests want/);
    expect(body).not.toMatch(/is everything the research found/);
  });

  it('sends the requested length and no other', () => {
    expect(responseLengthBlock('short')).toMatch(/^\n\n\*\*Requested response length:\*\* short/);
    expect(responseLengthBlock('short')).toMatch(/the conclusion, the reasoning behind it, and the one thing worth watching for/);
    expect(responseLengthBlock('short')).not.toMatch(/the whole research, laid out so it can be navigated/);
    expect(responseLengthBlock('long')).toMatch(/is the default and is what most requests want/);
    expect(responseLengthBlock('long')).not.toMatch(/a few paragraphs of prose/);
    expect(responseLengthBlock('exhaustive')).toMatch(/the whole research, laid out so a reader can navigate/);
    expect(responseLengthBlock('exhaustive')).not.toMatch(/is the default and is what most requests want/);
  });

  it('separates the three lengths by coverage rather than by banning markdown', () => {
    /* `short` was measured at 526 and 2,083 characters under the old wording,
       which said what to add but not how far to go. The distinction that works
       is how much of the research gets written down. */
    expect(responseLengthBlock('short')).toMatch(/Cover the main points rather than every point/);
    expect(responseLengthBlock('long')).toMatch(/what the whole picture means/);
    expect(responseLengthBlock('exhaustive')).toMatch(/keep what you would otherwise have cut/);
  });

  it('opens the long answer with the conclusion itself, because "give the conclusion" measured as a labelled section', () => {
    /* Two live runs under `long` produced a "Short answer" heading before the
       answer. The spec now describes the opening as the answer's first prose. */
    expect(responseLengthBlock('long')).toMatch(/Open with the conclusion itself as the answer's first prose/);
  });

  it('never states a length as a prohibition', () => {
    /* "No headings, no tables, no diagrams" was tried and rejected. A ban draws
       attention to the thing it bans, and the model kept producing tables under
       it. Each length says what to write instead. */
    for (const length of ['short', 'long', 'exhaustive'] as const) {
      const spec = responseLengthBlock(length);
      expect(spec).not.toMatch(/\bNo\b|\bno (headings|tables|diagrams|comparison)/);
      expect(spec).not.toMatch(/never|don't|do not|avoid/);
    }
  });

  it('names the length verbatim so the model need not guess which rule applies', () => {
    /* The label token and the definition travel together in one block. */
    for (const length of ['short', 'long', 'exhaustive'] as const) {
      const block = responseLengthBlock(length);
      expect(block).toContain(`**Requested response length:** ${length}`);
      expect(block).toContain(`\`${length}\``);
      /* The definition starts its own line. Running it into the label line made
         the block read as one run-on sentence at the end of the prompt. */
      expect(block).toMatch(new RegExp(`\\*\\* ${length}\\n- `));
    }
  });
});

describe('prose is the default shape', () => {
  it('starts with the answer itself, not a heading or label announcing it', () => {
    /* Measured: seven runs opened with a label like "Short answer" before the
       conclusion, in the request's language. The label narrates the answer's
       shape instead of giving the answer. */
    expect(body).toMatch(/The first line is the answer itself: no heading, label, or announcement/);
    expect(body).toMatch(/such as "Short answer" or "Conclusion" comes before it/);
  });

  it('states prose as the default', () => {
    expect(body).toMatch(/\*\*Write connected prose by default\.\*\*/);
    expect(body).toMatch(/Do not fragment a single argument into a stack of short bullet points/);
  });

  it('no longer maps bullets and headings to ordinary content', () => {
    expect(body).not.toMatch(/bullets for lists/);
    expect(body).not.toMatch(/headings for long answers/);
  });

  it('gates tables on genuinely tabular content', () => {
    expect(body).toMatch(/\*\*Use a table only when the content is genuinely tabular\*\*/);
    expect(body).toMatch(/A single fact, a short answer, or a two-item contrast does not need one/);
  });

  it('requires synthesis prose after a table, with thin sources marked', () => {
    expect(body).toMatch(/\*\*After a table, write the synthesis\.\*\*/);
    /* The rule used to name cell against pack and gravimetric against
       volumetric, which read as an instruction about batteries. It now names the
       property: figures on scales that cannot be compared. */
    expect(body).toMatch(/figures measured on incompatible scales/);
    expect(body).toMatch(/Never present a contested figure as settled/);
  });

  it('gates lists on the answer genuinely being a list', () => {
    expect(body).toMatch(/\*\*Use a list only when the answer genuinely is a list\*\*/);
    expect(body).toMatch(/Never turn prose into bullets to save effort/);
  });

  it('gates headings on long multi-part answers', () => {
    expect(body).toMatch(/\*\*Use headings only for genuinely long, multi-part answers\.\*\*/);
    expect(body).toMatch(/A short answer gets no headings at all/);
  });

  it('keeps emphasis minimal and no longer carves out a note headline', () => {
    /* Both exception sentences were dead text once the note became a tool call,
       and leaving them invited bold in the answer. */
    expect(body).toMatch(/Keep emphasis minimal\./);
    expect(body).toMatch(/do not add decorative markdown/);
    expect(body).not.toMatch(/bold headline on a progress note/);
    expect(body).not.toMatch(/Keep emphasis minimal \*\*in the answer\.\*\*/);
  });

  it('weaves uncertainty into prose instead of a disclaimer block', () => {
    expect(body).toMatch(/Weave this into the prose where it belongs/);
  });
});

describe('the prompt does not ask for status notes', () => {
  /* The rule was in the prompt for eight attempts and then moved to the
     report_progress tool. These assertions stop it creeping back. */
  it('carries no narration instruction of any kind', () => {
    expect(body).not.toMatch(/Narrate as you go/);
    expect(body).not.toMatch(/A status note is output, not thought/);
    expect(body).not.toMatch(/Every two to four turns/);
    expect(body).not.toMatch(/leave a blank line/);
    expect(body).not.toMatch(/bold headline/);
  });

  it('turns a collection request into one need per member', () => {
    /* A plan item naming a region was marked done while three of its ten
       countries never reached the answer. A group is only finished when its
       members are. */
    expect(body).toMatch(/first establish which items belong to the collection/);
    expect(body).toMatch(/then treat each member as its own need/);
    expect(body).toMatch(/only finished when every member of that group is covered/);
  });

  it('stops on coverage rather than on effort being spent', () => {
    /* "Remaining effort would not change the answer" was a cheap exit: a run
       covered 14 of roughly 20 countries and stopped, because the other 6 would
       not have changed the answer to the 14 it already had. */
    expect(body).toMatch(/corroborated and every part of the request is covered/);
    expect(body).not.toMatch(/remaining effort would not change the answer/);
    /* The wrap-up signal stays as a second route out. */
    expect(body).toMatch(/or when a wrap-up signal appears/);
  });

  it('leaves Step 0 unscoped, since scoping it once made notes worse', () => {
    /* Two prohibitions were added to Step 0 and to the note rule in the same
       attempt. Both regressed the result to zero bold headlines, so neither
       survives. */
    expect(body).toMatch(/assess the evidence needs/);
    expect(body).not.toMatch(/Assess this silently, in your reasoning/);
  });

  it('carries no worked example, so the model has to write its own notes', () => {
    /* Three worked cases had leaked in: a battery comparison naming cell against
       pack, a legality example, and a note about remembered examples. They came
       from real questions, which is exactly why they read as harmless. The
       check covers the abbreviations too, because `e.g.` was sitting in a mode
       block while this test only looked for the two spellings above. */
    expect(body).not.toMatch(/For example/);
    expect(body).not.toMatch(/such as \*\*/);
    expect(body).not.toMatch(/\be\.g\./);
    expect(body).not.toMatch(/cell versus pack|gravimetric versus volumetric/);
    expect(body).not.toMatch(/"is X legal"/);
    expect(body).not.toMatch(/remembered examples plus a link/);
  });

  it('keeps the same rule in the mode blocks, not only in the body', () => {
    for (const mode of ['instant', 'default', 'deep', 'max'] as const) {
      const block = modeBehaviorBlock(resolveResearchPreset(mode));
      expect(block).not.toMatch(/\be\.g\./);
      expect(block).not.toMatch(/For example/);
    }
  });

  it('holds the prohibition count at the level that keeps correctness rules', () => {
    /* Prohibitions were measured twice: they lower compliance, and a note told
       to avoid something got written five turns out of five. Most were rewritten
       as positive instructions. What remains is the set where a prohibition is
       the rule itself: fabricating evidence, averaging conflicting figures,
       inventing a citation, presenting a contested figure as settled. Rewriting
       those positively would weaken them, so the count is pinned instead, and
       a new prohibition has to be justified against this number. */
    /* Code comments are excluded: two of the matches are in a file header and a
       regex, and neither is model-visible. */
    const instructions = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\*.*$/gm, ' ');
    const count = (instructions.match(/\bNever\b|\b[Dd]o not\b/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(14);
  });
});

describe('the agent reads its budget on demand', () => {
  it('names read_budget in the work cycle, because the schema alone will not be called', () => {
    /* Same lesson as report_progress: defined in the schema and silent in the
       prompt, a tool whose purpose has to be inferred collected zero calls. */
    expect(body).toMatch(/Size each batch from `read_budget`/);
    expect(body).toMatch(/in the same response as the next search or fetch/);
  });

  it('demands reconnaissance before planning, and evidence on done', () => {
    /* A turn-zero plan with generic items closed in bulk was the measured
       shortcut. The rule lives in the prompt; the refusal lives in the engine,
       so this pins only the words. */
    expect(body).toMatch(/Reconnaissance first/);
    expect(body).toMatch(/each item names its open question and where the answer should come from/);
    expect(body).toMatch(/carries their numbers in `evidence`/);
  });

  it('gives non-questions an exit instead of starving them below the floor', () => {
    /* High floors would force research on greetings. The exit is a named
       tool with a narrow contract, in both places like report_progress. */
    expect(body).toMatch(/\*\*Not a research request\.\*\*/);
    expect(body).toMatch(/call `decline_request` with the reason instead of researching/);
    expect(body).toMatch(/researched and reported with gaps, not declined/);
  });

  it('states the batching contract in the schema, where the call decision is made', () => {
    expect(READ_BUDGET_TOOL.function.name).toBe('read_budget');
    expect(READ_BUDGET_TOOL.function.description).toMatch(/same response/);
    expect(READ_BUDGET_TOOL.function.description).toMatch(/including the other calls in that response/);
  });

  it('holds default above instant: every key claim is fetched and cited from reading', () => {
    /* The ladder is instant < default < deep. Default demands what instant
       does not: no key claim resting on a snippet, and citations written from
       the fetched page. Measured: a default run answered 8,625 chars with
       zero [N] markers, dropping all 60 claims to gaps. */
    expect(mode('default')).toMatch(/A snippet never verifies a key claim/);
    expect(mode('default')).toMatch(/cite what you read rather than what the snippet suggested/);
    expect(mode('instant')).not.toMatch(/A snippet never verifies/);
    expect(mode('default')).toMatch(/or when a wrap-up signal appears/);
  });

  it('states the answer floor in every mode block, with that mode’s numbers', () => {
    /* The floor travels with the mode so the model plans to meet it instead
       of discovering it from a bounce. The engine reads the same numbers. */
    expect(mode('instant')).toMatch(/Answer floor: run at least 4 searches and read at least 10 pages/);
    expect(mode('default')).toMatch(/Answer floor: run at least 8 searches and read at least 15 pages/);
    expect(mode('deep')).toMatch(/Answer floor: run at least 20 searches and read at least 30 pages/);
    expect(mode('max')).toMatch(/Answer floor: run at least 50 searches and read at least 80 pages/);
  });

  it('hardens instant to search wide, leaving speed to the ceilings', () => {
    /* "Spend as few calls as the evidence needs" read as permission to stop
       early: two measured runs halted at 4 of 8 steps with ceilings untouched.
       The ceilings bound the cost; the prompt now asks for coverage. */
    expect(mode('instant')).toMatch(/different phrasings across different source categories/);
    expect(mode('instant')).not.toMatch(/Spend as few calls/);
    expect(mode('instant')).toMatch(/or when a wrap-up signal appears/);
  });
});

describe('code engine prompt', () => {
  const codeBody = getCodeSystemPrompt();

  it('names run_code and never a classic tool, because the engines do not share a prompt', () => {
    /* Two engines, two prompts. The classic body speaks web_search/fetch_url;
       this one speaks programs. A hybrid prompt is how the two architectures
       fight inside one loop. */
    expect(codeBody).toContain(RUN_CODE_TOOL_NAME);
    expect(RUN_CODE_TOOL.function.name).toBe(RUN_CODE_TOOL_NAME);
    expect(codeBody).not.toMatch(/web_search|fetch_url|recall_source|report_progress|read_budget/);
    expect(body).not.toContain('run_code');
  });

  it('states the print budget and bans paging a page through slices', () => {
    /* P0 measured the failure: the model printed text[6000:11021], then
       text[3900:6000], then text[1500:3900] of the same page, and each print
       came back clipped. An invisible clip teaches nothing; the budget is
       stated. */
    expect(codeBody).toMatch(/under 2,000 characters/);
    expect(codeBody).toMatch(/never page through a page by printing it in slices/i);
  });

  it('names the sandbox plan, budget, and decline functions', () => {
    /* D7 keeps run_code the only LLM tool; planning, budget, and decline live
       behind the RPC boundary instead. The prompt must name them or the model
       infers nothing, per the report_progress lesson. */
    expect(codeBody).toMatch(/await plan\(/);
    expect(codeBody).toMatch(/await plan_update\(/);
    expect(codeBody).toMatch(/await budget\(\)/);
    expect(codeBody).toMatch(/await decline\(/);
    expect(codeBody).not.toMatch(/web_search|fetch_url|recall_source|report_progress|read_budget|create_plan|edit_plan|read_plan|decline_request/);
  });

  it('keeps raw page text in the sandbox and names read_source and state', () => {
    expect(codeBody).toMatch(/stays in the sandbox/);
    expect(codeBody).toContain('read_source');
    expect(codeBody).toContain('state');
  });

  it('names the first move, because measured code runs answered with zero tool calls', () => {
    /* Five of six measured code-engine runs answered in round 0 with no
       run_code call at all while the classic prompt researched the same query
       on the same model. The first-action rule is the prompt-side test: if it
       does not hold in the fixed suite, the next step is structural. */
    expect(codeBody).toMatch(/\*\*The first program searches\.\*\*/);
    expect(codeBody).toMatch(/before any program has returned/);
    expect(codeBody).toMatch(/That first program only searches/);
  });

  it('has no verifier prompt: three live runs never fired it', () => {
    /* Retired per its own condition: the one-pass check only ran on voluntary
       answers, and every measured code run ended forced at a ceiling. A check
       that cannot fire is dead weight, however principled its design. */
    expect(codeBody).not.toMatch(/verify a draft/i);
  });
});
