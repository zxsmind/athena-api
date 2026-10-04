import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatOf, readStructuredFile, writeStructuredFile } from '../src/config-file.js';
import { bytes, compactNumber, money } from '../src/cli/ui.js';
import { formatAge, formatDuration } from '../src/cli/stats.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-config-'));
});

describe('formatOf', () => {
  it('treats .yaml and .yml as YAML and everything else as JSON', () => {
    expect(formatOf('a/settings.yaml')).toBe('yaml');
    expect(formatOf('a/settings.yml')).toBe('yaml');
    expect(formatOf('a/settings.json')).toBe('json');
  });
});

describe('readStructuredFile', () => {
  it('returns an empty object when the file is missing', () => {
    expect(readStructuredFile(join(dir, 'missing.yaml'))).toEqual({});
  });

  it('reads YAML with nested maps and lists', () => {
    const path = join(dir, 'settings.yaml');
    writeFileSync(path, 'providers:\n  anthropic:\n    enabled: true\n    keys:\n      - a\n      - b\n', 'utf-8');
    expect(readStructuredFile(path)).toEqual({
      providers: { anthropic: { enabled: true, keys: ['a', 'b'] } },
    });
  });

  it('reads a JSON file by extension', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{"port":3001}', 'utf-8');
    expect(readStructuredFile(path)).toEqual({ port: 3001 });
  });

  it('reads an empty YAML document as an empty object', () => {
    const path = join(dir, 'empty.yaml');
    writeFileSync(path, '', 'utf-8');
    expect(readStructuredFile(path)).toEqual({});
  });

  it('throws a format-specific error for broken YAML', () => {
    const path = join(dir, 'broken.yaml');
    writeFileSync(path, 'a:\n  - b\n c: bad indent\n', 'utf-8');
    expect(() => readStructuredFile(path)).toThrow(/not valid YAML/);
  });
});

describe('writeStructuredFile', () => {
  it('writes YAML and round-trips through the reader', () => {
    const path = join(dir, 'out.yaml');
    writeStructuredFile(path, { port: 3001, providers: { google: { keys: ['k'] } } });
    expect(readStructuredFile(path)).toEqual({ port: 3001, providers: { google: { keys: ['k'] } } });
  });

  it('creates missing parent directories', () => {
    const path = join(dir, 'nested', 'deep', 'out.yaml');
    writeStructuredFile(path, { ok: true });
    expect(existsSync(path)).toBe(true);
  });

  it('writes JSON when the extension says JSON', () => {
    const path = join(dir, 'out.json');
    writeStructuredFile(path, { port: 3001 });
    expect(readFileSync(path, 'utf-8')).toBe('{\n  "port": 3001\n}');
  });
});

describe('formatters', () => {
  it('formats byte sizes', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(10 * 1024 * 1024)).toBe('10.0 MB');
  });

  it('compacts large numbers', () => {
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(1_500_000)).toBe('1.5M');
  });

  it('formats credits as money', () => {
    expect(money(0.5)).toBe('$0.5000');
  });

  it('formats durations', () => {
    expect(formatDuration(30)).toBe('30s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(7_500)).toBe('2h 5m');
  });

  it('formats ages and handles never', () => {
    expect(formatAge(null)).toBe('never');
    expect(formatAge(new Date(Date.now() - 120_000).toISOString())).toBe('2m ago');
  });
});
