import { afterEach, describe, expect, it, vi } from 'vitest';
import { redirectConsoleToStderr } from '../src/cli/stdio.js';

describe('athena mcp on stdio', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes every console method to stderr, leaving stdout for the protocol', () => {
    /* An MCP client on stdio parses JSON-RPC frames off stdout, so a stray
       console line there is indistinguishable from a malformed frame: the client
       reports a protocol error instead of ignoring a log. The server logs through
       all four methods, so all four are redirected. */
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    redirectConsoleToStderr();

    const frames: string[] = [];
    const stdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      frames.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      console.log('a log line');
      console.info('an info line');
      console.warn('a warning');
      console.debug('a debug line');
      /* What the transport actually writes: a protocol frame. */
      process.stdout.write('{"jsonrpc":"2.0"}\n');
    } finally {
      process.stdout.write = stdoutWrite;
    }

    expect(error.mock.calls.map((call) => call[0])).toEqual([
      'a log line',
      'an info line',
      'a warning',
      'a debug line',
    ]);
    expect(frames).toEqual(['{"jsonrpc":"2.0"}\n']);
  });
});
