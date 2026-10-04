/**
 * Pyodide sandbox host. Spawned once per job by `pyodide-session.ts`; it never
 * runs in the server process.
 *
 * Newline-delimited JSON on stdin/stdout:
 *   parent -> host: { type: 'run', id, code }
 *                   { type: 'hydrate', id, state }
 *                   { type: 'state', id }
 *                   { type: 'rpc_result', id, value | error }
 *   host -> parent: { type: 'ready' }
 *                   { type: 'rpc', id, fn, args }
 *                   { type: 'result', id, ok, value?, stdout?, error? }
 *
 * `state` is the only thing the parent can persist: Python globals outside it
 * are not serialisable, and the design accepts that (D4). The program reaches
 * the network only through the injected async functions; `fetch` and friends
 * are removed before Pyodide loads, and the host filesystem is not mounted
 * into the Python VFS.
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { loadPyodide, type PyodideInterface } from 'pyodide';

const require = createRequire(import.meta.url);
const indexURL = dirname(require.resolve('pyodide/package.json'));

for (const name of ['fetch', 'WebSocket', 'XMLHttpRequest']) {
  try {
    delete (globalThis as Record<string, unknown>)[name];
  } catch {
    /* Non-configurable; the network capability is still outside the VFS. */
  }
}

const pyodide: PyodideInterface = await loadPyodide({ indexURL });

/** Characters one message may add to the pipe. The parent clips for the model. */
const HOST_CLIP = 200_000;

let stdout: string[] | null = null;
pyodide.setStdout({ batched: (text: string) => stdout?.push(text) });
pyodide.setStderr({ batched: (text: string) => stdout?.push(text) });

const pending = new Map<string, (message: { value?: unknown; error?: string }) => void>();

function write(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + `... [clipped ${text.length - max} chars]` : text;
}

function callEngine(fn: string, argsJson: string): Promise<unknown> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => (message.error ? reject(new Error(message.error)) : resolve(message.value)));
    write({ type: 'rpc', id, fn, args: JSON.parse(argsJson) });
  });
}

pyodide.globals.set('_engine_call_js', callEngine);

await pyodide.runPythonAsync(`
import json as _json

async def search(args):
    proxy = await _engine_call_js("search", _json.dumps(args))
    return proxy.to_py()

async def extract(args):
    proxy = await _engine_call_js("extract", _json.dumps(args))
    return proxy.to_py()

async def read_source(args):
    proxy = await _engine_call_js("read_source", _json.dumps(args))
    return proxy.to_py()

async def plan(args):
    proxy = await _engine_call_js("plan", _json.dumps(args))
    return proxy.to_py()

async def plan_update(args):
    proxy = await _engine_call_js("plan_update", _json.dumps(args))
    return proxy.to_py()

async def plan_read(args={}):
    proxy = await _engine_call_js("plan_read", _json.dumps(args))
    return proxy.to_py()

async def budget(args={}):
    proxy = await _engine_call_js("budget", _json.dumps(args))
    return proxy.to_py()

async def decline(args):
    proxy = await _engine_call_js("decline", _json.dumps(args))
    return proxy.to_py()

def _engine_export_state():
    return _json.dumps(state)

state = {}
`);

function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const proxy = value as { toJs?: () => unknown };
  if (typeof proxy.toJs === 'function') {
    try {
      return proxy.toJs();
    } catch {
      return String(value);
    }
  }
  return value;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return String(value);
  }
}

function errorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const marker = text.lastIndexOf('\n');
  return clip((marker >= 0 ? text.slice(marker + 1) : text).trim() || text, 600);
}

async function execute(id: string, code: string): Promise<void> {
  const logs: string[] = [];
  stdout = logs;
  try {
    const raw = await pyodide.runPythonAsync(code);
    write({ type: 'result', id, ok: true, value: clip(stringify(serialize(raw) ?? ''), HOST_CLIP), stdout: clip(logs.join('\n'), HOST_CLIP) });
  } catch (error) {
    write({ type: 'result', id, ok: false, error: errorLine(error), stdout: clip(logs.join('\n'), HOST_CLIP) });
  } finally {
    stdout = null;
  }
}

async function hydrate(id: string, state: string): Promise<void> {
  try {
    pyodide.globals.set('_engine_state_json', state);
    await pyodide.runPythonAsync('state = _json.loads(_engine_state_json)\ntrue');
    write({ type: 'result', id, ok: true, value: '' });
  } catch (error) {
    write({ type: 'result', id, ok: false, error: errorLine(error), value: '' });
  }
}

let queue: Promise<void> = Promise.resolve();
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let index: number;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line) as { type: string; id: string; code?: string; state?: string; value?: unknown; error?: string };
    if (message.type === 'rpc_result') {
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle(message);
      }
    } else if (message.type === 'run') {
      queue = queue.then(() => execute(message.id, message.code ?? ''));
    } else if (message.type === 'hydrate') {
      queue = queue.then(() => hydrate(message.id, message.state ?? '{}'));
    } else if (message.type === 'state') {
      queue = queue.then(async () => {
        try {
          const raw = await pyodide.runPythonAsync('_engine_export_state()');
          write({ type: 'result', id: message.id, ok: true, value: stringify(serialize(raw)), stdout: '' });
        } catch (error) {
          write({ type: 'result', id: message.id, ok: false, error: errorLine(error), value: '', stdout: '' });
        }
      });
    }
  }
});

write({ type: 'ready' });
