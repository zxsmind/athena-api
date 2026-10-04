import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The trace has no runtime test of its own, so these read the source rather than
 * calling the functions: `summarizeMessages` is private to llm.ts, and the thing
 * that actually broke was the call site that passed its result instead of the
 * messages themselves. A missing `messages_full` costs nothing at runtime and
 * everything when someone is trying to find out why a run answered wrongly, which
 * is the one job a trace exists to do.
 *
 * Reading source in a test is a trade. It is brittle to refactoring, and it is
 * still cheaper than the alternative this repository already lived through: a
 * trace that recorded the size of a conversation but none of its content, and a
 * 365,000-character context that could not be audited after the fact.
 */
const LLM = readFileSync(new URL('../src/llm.ts', import.meta.url), 'utf-8');
const ENGINE = readFileSync(new URL('../src/engine.ts', import.meta.url), 'utf-8');
const TRACE = readFileSync(new URL('../src/trace.ts', import.meta.url), 'utf-8');

describe('llm.attempt records the conversation, not just its size', () => {
  it('passes the messages themselves alongside the summary', () => {
    /* The summary counts: message count, total characters, roles. It cannot say
       which page the model read or what that page said, which is the only
       question worth asking a trace after a wrong answer. */
    expect(LLM).toMatch(/messages: summarizeMessages\(options\.messages\)/);
    expect(LLM).toMatch(/messages_full: options\.messages/);
  });

  it('keeps the summary, because the counts are what a reader scans first', () => {
    expect(LLM).toMatch(/messages: summarizeMessages\(options\.messages\)/);
  });
});

describe('the assembled system prompt is recorded once per run', () => {
  it('writes it under its own event kind', () => {
    expect(TRACE).toMatch(/'prompt\.assembled'/);
    expect(ENGINE).toMatch(/traceEvent\(traceId, 'prompt\.assembled'/);
  });

  it('records the prompt whole, since it is assembled from four separate sources', () => {
    /* base prompt + today's date + response length block + notebook constraints
       + mode behaviour block. A trace holding only the query could not attribute
       a behaviour to the instruction that caused it. */
    expect(ENGINE).toMatch(/system_prompt: systemPrompt/);
  });

  it('names the response length, so a run can be matched to the spec it was given', () => {
    expect(ENGINE).toMatch(/response_length: options\.responseLength \?\? DEFAULT_RESPONSE_LENGTH/);
    expect(ENGINE).toMatch(/response_length: options\.responseLength \?\? null/);
  });

  it('writes the prompt after it is assembled rather than before', () => {
    /* An earlier version put the field on run.start, where the variable it read
       was not yet declared. The compiler caught it; this pins the ordering so a
       moved declaration is a test failure rather than a surprise at run time. */
    const assemble = ENGINE.indexOf('const systemPrompt =');
    const trace = ENGINE.indexOf("traceEvent(traceId, 'prompt.assembled'");
    expect(assemble).toBeGreaterThan(-1);
    expect(trace).toBeGreaterThan(assemble);
  });
});

describe('trace fidelity', () => {
  it('documents that the JSONL is now unbounded where it matters', () => {
    /* maxValueChars still clips ordinary event values so one runaway page cannot
       produce a multi-megabyte line. The conversation is exempt, deliberately,
       because clipping it is what made the trace unauditable. */
    expect(TRACE).toMatch(/maxValueChars/);
    expect(LLM).toMatch(/The JSONL line grows with the\s+context/);
  });
});