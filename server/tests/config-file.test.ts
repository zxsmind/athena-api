import { beforeEach, describe, expect, it, vi } from 'vitest';

/* In-memory fs for config-file: records every write and rename so the atomic
   write can be observed without touching the checkout. Runs in this test
   file only; other files keep their own mocks. */
const files = new Map<string, string>();
const renameCalls: Array<{ from: string; to: string }> = [];
let renameFailuresLeft = 0;
let failureCode = 'EPERM';

vi.mock('node:fs', () => ({
  existsSync: (path: string) => files.has(path),
  mkdirSync: () => undefined,
  readFileSync: (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error('ENOENT');
    return content;
  },
  writeFileSync: (path: string, data: string) => {
    files.set(path, data);
  },
  renameSync: (from: string, to: string) => {
    renameCalls.push({ from, to });
    if (renameFailuresLeft > 0) {
      renameFailuresLeft -= 1;
      throw Object.assign(new Error(`rename failed (${failureCode})`), { code: failureCode });
    }
    const content = files.get(from);
    if (content === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    files.delete(from);
    files.set(to, content);
  },
}));

import { formatOf, readStructuredFile, writeStructuredFile } from '../src/config-file.js';

beforeEach(() => {
  files.clear();
  renameCalls.length = 0;
  renameFailuresLeft = 0;
  failureCode = 'EPERM';
});

describe('writeStructuredFile', () => {
  it('writes beside the target and renames into place', () => {
    writeStructuredFile('/x/config.json', { a: 1 });

    expect(renameCalls).toEqual([{ from: '/x/config.json.tmp', to: '/x/config.json' }]);
    expect(files.has('/x/config.json.tmp')).toBe(false);
    expect(files.get('/x/config.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('retries a transient rename lock instead of losing the write', () => {
    /* An editor or AV holding the destination raises EPERM on Windows, where
       NTFS fails a rename over an open file that POSIX would have completed.
       The retry must recover the write, not throw the lock at the caller. */
    renameFailuresLeft = 2;
    writeStructuredFile('/x/config.json', { a: 1 });

    expect(renameCalls).toHaveLength(3);
    expect(files.get('/x/config.json')).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('throws a permanent rename failure without retrying', () => {
    failureCode = 'ENOENT';
    renameFailuresLeft = 5;
    expect(() => writeStructuredFile('/x/config.json', { a: 1 })).toThrow('ENOENT');
    expect(renameCalls).toHaveLength(1);
  });
});

describe('readStructuredFile', () => {
  it('reads the format by extension', () => {
    files.set('/x/config.json', '{"a":1}');
    expect(readStructuredFile('/x/config.json')).toEqual({ a: 1 });
    expect(formatOf('/x/settings.yaml')).toBe('yaml');
    expect(formatOf('/x/settings.json')).toBe('json');
  });

  it('reads a missing file as an empty object', () => {
    expect(readStructuredFile('/x/absent.json')).toEqual({});
  });
});
