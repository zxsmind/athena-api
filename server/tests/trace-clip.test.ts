import { describe, expect, it } from 'vitest';
import { enableTrace, traceEvent } from '../src/trace.js';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDataPath } from '../src/storage.js';

/**
 * `clip` is private, so this drives it through the public writer and reads the
 * line back. That is deliberate: the bug it guards was a depth mismatch, where
 * the message array sat one level deeper than the check expected and every tool
 * result was cut at 4,000 characters. Testing the exported function would have
 * passed while the trace stayed unauditable.
 */
const jobId = 'test-trace-fidelity-clip';
const path = resolve(getDataPath('traces'), `${jobId}.jsonl`);

function write(data: Record<string, unknown>): Record<string, unknown> {
  enableTrace();
  rmSync(path, { force: true });
  traceEvent(jobId, 'llm.attempt', data, 0);
  const line = readFileSync(path, 'utf-8').trim().split('\n')[0];
  return JSON.parse(line).data as Record<string, unknown>;
}

describe('tool results inside the recorded conversation survive intact', () => {
  /* 4,021 is one over the clip ceiling. Three of the tool results in a measured
     run sat at exactly 4,021, 4,021 and 4,020: every long page stopped at the
     same place, which is the one place where a trace stops being able to say
     what the model read. */
  const LONG = 'x'.repeat(9_000);

  it('keeps a tool result longer than the clip ceiling whole', () => {
    const messages = [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'query' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'fetch_url', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: LONG },
    ];
    const out = write({ messages: { count: 4, chars: LONG.length }, messages_full: messages });
    const full = out.messages_full as { content: string }[];
    expect(full[3].content).toBe(LONG);
    expect(full[3].content).not.toMatch(/chars total/);
  });

  it('still clips ordinary event values, so one runaway page cannot flood the file', () => {
    /* The exemption is scoped to the conversation. maxValueChars exists for a
       reason and applying it everywhere except messages is the whole design. */
    const out = write({ snippet: LONG, messages_full: [{ role: 'tool', content: LONG }] });
    expect(out.snippet).toMatch(/chars total/);
    expect((out.messages_full as { content: string }[])[0].content).toBe(LONG);
  });

  it('keeps tool call arguments readable, since that is the question being asked', () => {
    const out = write({
      messages_full: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: JSON.stringify({ queries: [LONG] }) } }],
        },
      ],
    });
    const call = (out.messages_full as { tool_calls: { function: { arguments: string } }[] }[])[0].tool_calls[0];
    expect(call.function.arguments).toContain(LONG.slice(0, 500));
  });

  it('does not mistake an arbitrary list of objects for a conversation', () => {
    /* The exemption keys on messages having a string `role`. Without that check,
       any list of role-shaped objects elsewhere in an event would go unclipped
       too, which is a hole rather than an exemption. */
    const out = write({ results: [{ role: 'x', content: LONG }, { role: 'y', content: LONG }] });
    expect(JSON.stringify(out.results)).toMatch(/chars total/);
  });

  it('leaves an empty message list alone', () => {
    const out = write({ messages_full: [] });
    expect(out.messages_full).toEqual([]);
  });
});