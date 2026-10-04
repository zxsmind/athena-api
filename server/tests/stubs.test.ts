import { describe, expect, it } from 'vitest';
import { clearEligibleMessages, renderStub } from '../src/engine/stubs.js';
import { storeEvidence } from '../src/engine/evidence-store.js';

/* DATA_DIR isolation comes from tests/setup.ts. Job ids are unique per test. */

let counter = 0;
function jobId(): string {
  counter += 1;
  return `stubs-test-${counter}`;
}

function store(id: string, index: number, round: number): void {
  storeEvidence(id, {
    sourceIndex: index,
    url: `https://example.org/${index}`,
    title: `Title ${index}`,
    kind: 'page',
    fetched: true,
    text: `content of source ${index}`,
    round,
  });
}

function toolMessage(content: string): { role: string; content: string } {
  return { role: 'tool', content };
}

describe('stubs and the clearing gate', () => {
  it('renders a stub that keeps the number, kind, url, size and reopen call', () => {
    const id = jobId();
    store(id, 7, 1);
    const stub = renderStub({
      sourceIndex: 7,
      url: 'https://example.org/tariffs',
      title: 'Tariffs',
      kind: 'page',
      fetched: true,
      tokens: 12_400,
      text: 'x',
      sha256: 'y',
      round: 1,
    });
    expect(stub).toContain('[Source #7');
    expect(stub).toContain('page, fetched');
    expect(stub).toContain('https://example.org/tariffs');
    expect(stub).toContain('12.4K tok');
    expect(stub).toContain('recall_source({source: 7})');
    expect(stub).not.toContain('Tariffs payable');
  });

  it('clears a message only when every source in it is stored and old', () => {
    const id = jobId();
    store(id, 1, 1);
    store(id, 2, 1);
    const messages = [toolMessage('[Source #1] first\n[Source #2] second')];
    const result = clearEligibleMessages(messages, id, 6, 4);
    expect(result.clearedMessages).toBe(1);
    expect(result.stubbedSources).toBe(2);
    expect(messages[0].content).toContain('recall_source({source: 1})');
    expect(messages[0].content).toContain('recall_source({source: 2})');
    expect(messages[0].content).not.toContain('first');
  });

  it('never clears what was not stored', () => {
    const id = jobId();
    store(id, 1, 1);
    const messages = [toolMessage('[Source #1] kept\n[Source #9] missing')];
    const result = clearEligibleMessages(messages, id, 6, 4);
    expect(result.clearedMessages).toBe(0);
    expect(messages[0].content).toContain('missing');
  });

  it('keeps recent rounds raw even when stored', () => {
    const id = jobId();
    store(id, 1, 5);
    const messages = [toolMessage('[Source #1] recent')];
    const result = clearEligibleMessages(messages, id, 6, 4);
    expect(result.clearedMessages).toBe(0);
    expect(messages[0].content).toContain('recent');
  });

  it('leaves non-tool messages and sourceless text alone', () => {
    const id = jobId();
    const messages = [
      { role: 'assistant', content: '[Source #1] not a tool result' },
      toolMessage('no sources here at all'),
    ];
    const result = clearEligibleMessages(messages, id, 6, 4);
    expect(result.clearedMessages).toBe(0);
    expect(messages[0].content).toContain('not a tool result');
  });
});
