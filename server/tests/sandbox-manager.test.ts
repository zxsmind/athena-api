import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config/defaults.js';
import { resetConfigForTests, setConfig } from '../src/config/load.js';
import { closeAllSandboxes, runInSandbox, setSandboxFactoryForTests } from '../src/sandbox/manager.js';
import type { SandboxHandlers, SandboxSession } from '../src/sandbox/types.js';

const handlers: SandboxHandlers = {
  search: async () => ({}),
  extract: async () => ({}),
  read_source: async () => ({}),
};

function configure(enabled: boolean, maxConcurrent: number): void {
  setConfig({ ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled, maxConcurrent } });
}

/** A session whose `hold` program blocks until the gate opens, and which
 *  records how many sessions the manager created. */
function installFake(gate: Promise<void>): { created: number[] } {
  const created: number[] = [];
  let nextId = 1;
  setSandboxFactoryForTests(() => {
    created.push(nextId++);
    const session: SandboxSession = {
      setHandlers: () => undefined,
      run: async (code) => {
        if (code === 'hold') await gate;
        return { ok: true, value: code, stdout: '' };
      },
      exportState: async () => null,
      hydrate: () => undefined,
      close: () => undefined,
    };
    return session;
  });
  return { created };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

afterEach(() => {
  closeAllSandboxes();
  setSandboxFactoryForTests(null);
  resetConfigForTests();
});

describe('sandbox concurrency', () => {
  it('queues a run while the cap is taken and creates its session only when the slot frees', async () => {
    configure(true, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    const { created } = installFake(gate);

    const order: string[] = [];
    const first = runInSandbox('a', handlers, 'hold').then((result) => {
      order.push('a');
      return result;
    });
    await tick();
    const second = runInSandbox('b', handlers, 'b').then((result) => {
      order.push('b');
      return result;
    });
    await tick();
    expect(order).toEqual([]);
    expect(created.length).toBe(1);

    release();
    const [a, b] = await Promise.all([first, second]);
    expect(order).toEqual(['a', 'b']);
    expect(created.length).toBe(2);
    expect(a.value).toBe('hold');
    expect(b.value).toBe('b');
  });

  it('drops a queued run when its signal aborts, without touching the held slot', async () => {
    configure(true, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    installFake(gate);

    const held = runInSandbox('a', handlers, 'hold');
    await tick();
    const controller = new AbortController();
    const queued = runInSandbox('b', handlers, 'b', controller.signal);
    controller.abort();
    const result = await queued;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('aborted');

    release();
    expect((await held).ok).toBe(true);
  });

  it('refuses to run while the feature is disabled', async () => {
    configure(false, 4);
    const result = await runInSandbox('a', handlers, '1 + 1');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('disabled');
  });
});
