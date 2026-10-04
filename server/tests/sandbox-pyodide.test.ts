import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PyodideSession } from '../src/sandbox/pyodide-session.js';
import type { SandboxHandlers } from '../src/sandbox/types.js';

/**
 * Drives a real Pyodide process through the session. Slow by suite standards
 * (the interpreter is a WASM load), which is exactly why it exists: everything
 * the engine relies on — injected RPC, persistent globals, state export,
 * network isolation, timeout recovery — is a property of the process, not of a
 * mock.
 */
const calls: string[] = [];
const handlers: SandboxHandlers = {
  async search() {
    calls.push('search');
    return { results: [{ n: 1, title: 'Example', url: 'https://example.com', snippet: 'alpha' }] };
  },
  async extract() {
    calls.push('extract');
    return { n: 2, title: 'Page', url: 'https://example.com/p', chars: 5, text: 'hello' };
  },
  async read_source() {
    calls.push('read_source');
    return { n: 3, content: 'stored text' };
  },
};

let session: PyodideSession;

beforeAll(() => {
  session = new PyodideSession(handlers, { timeoutMs: 4_000 });
});

afterAll(() => {
  session.close();
});

describe('pyodide session', () => {
  it('runs a program against injected functions and keeps globals across runs', async () => {
    const first = await session.run([
      'r = await search({"queries": ["alpha"]})',
      'state["n"] = r["results"][0]["n"]',
      'print("got", state["n"])',
      'state["n"]',
    ].join('\n'));
    expect(first.ok).toBe(true);
    expect(first.stdout).toContain('got 1');
    expect(first.value).toContain('1');
    expect(calls).toEqual(['search']);

    const second = await session.run('state["n"] + 41');
    expect(second.ok).toBe(true);
    expect(second.value).toContain('42');
  });

  it('exports state and hydrates it back into a fresh program', async () => {
    const exported = await session.exportState();
    expect(exported).toContain('"n": 1');

    session.hydrate('{"n": 7}');
    const hydrated = await session.run('state["n"]');
    expect(hydrated.value).toContain('7');
  });

  it('cannot reach the network even though the host is Node', async () => {
    const result = await session.run([
      'try:',
      '    from js import fetch  # noqa: F401',
      '    outcome = "reachable"',
      'except Exception:',
      '    outcome = "blocked"',
      'outcome',
    ].join('\n'));
    expect(result.ok).toBe(true);
    expect(result.value).toContain('blocked');
  });

  it('answers concurrent injected calls inside one execution', async () => {
    /* P2 parallelism: asyncio.gather over several RPCs must interleave, not
       serialize. The second call has to start while the first is still
       pending; a serial pipe would stall until the session timeout instead. */
    let releaseFirst: (() => void) | null = null;
    let overlapped = false;
    session.setHandlers({
      ...handlers,
      search: (async () => {
        if (!releaseFirst) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        } else {
          overlapped = true;
          releaseFirst();
        }
        return { results: [] };
      }) as SandboxHandlers['search'],
    });
    try {
      const gathered = await session.run([
        'import asyncio',
        'r = await asyncio.gather(search({"queries": ["a"]}), search({"queries": ["b"]}))',
        'len(r)',
      ].join('\n'));
      expect(gathered.ok).toBe(true);
      expect(overlapped).toBe(true);
      expect(gathered.value).toContain('2');
    } finally {
      session.setHandlers(handlers);
    }
  });

  it('kills a runaway program and restarts with the previous state', async () => {
    const killed = await session.run('while True:\n    pass');
    expect(killed.timedOut).toBe(true);

    const recovered = await session.run('state["n"]');
    expect(recovered.ok).toBe(true);
    expect(recovered.value).toContain('7');
  }, 30_000);
});
