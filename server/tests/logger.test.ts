import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configureLogger, getLogFilePath, getLogLimits, log } from '../src/logger.js';
import { DATA_DIR } from '../src/storage.js';

/* The logger always writes inside the data directory, which the test setup
   points at a throwaway folder. */
const logFiles = (): string[] => readdirSync(DATA_DIR).filter((name) => name.startsWith('athena') && name.endsWith('.log')).sort();

beforeEach(() => {
  for (const name of logFiles()) rmSync(join(DATA_DIR, name), { force: true });
  configureLogger({ file: 'athena.log', maxFileBytes: 2048, keepFiles: 3, level: 'debug', echoToStdout: false });
});

afterAll(() => {
  for (const name of logFiles()) rmSync(join(DATA_DIR, name), { force: true });
});

describe('file logger', () => {
  it('appends timestamped lines to the active file', () => {
    log('info', 'first line');
    log('warn', 'second line');
    const text = readFileSync(getLogFilePath(), 'utf-8');
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T.*INFO {2}first line\n/);
    expect(text).toContain('WARN  second line');
  });

  it('writes structured metadata as JSON', () => {
    log('error', 'boom', { code: 'E_TEST' });
    expect(readFileSync(getLogFilePath(), 'utf-8')).toContain('{"code":"E_TEST"}');
  });

  it('skips lines below the configured level', () => {
    configureLogger({ level: 'warn' });
    log('debug', 'hidden');
    log('info', 'hidden too');
    log('warn', 'visible');
    const text = readFileSync(getLogFilePath(), 'utf-8');
    expect(text).not.toContain('hidden');
    expect(text).toContain('visible');
  });

  it('never lets the active file exceed the cap', () => {
    for (let index = 0; index < 500; index += 1) log('info', `line ${index} padding padding padding padding`);
    expect(statSync(getLogFilePath()).size).toBeLessThanOrEqual(2048 + 200);
  });

  it('rotates into numbered files and keeps exactly keepFiles of them', () => {
    for (let index = 0; index < 500; index += 1) log('info', `line ${index} padding padding padding padding`);
    expect(logFiles()).toEqual(['athena.1.log', 'athena.2.log', 'athena.3.log', 'athena.log']);
  });

  it('keeps the newest lines in the active file and older ones behind it', () => {
    for (let index = 0; index < 60; index += 1) log('info', `seq ${index} padding padding padding padding`);
    expect(readFileSync(getLogFilePath(), 'utf-8')).toContain('seq 59');
    expect(readFileSync(join(DATA_DIR, 'athena.1.log'), 'utf-8')).toMatch(/seq \d+/);
  });

  it('drops the oldest file instead of growing without bound', () => {
    for (let round = 0; round < 5; round += 1) {
      for (let index = 0; index < 100; index += 1) log('info', `round ${round} line ${index} padding padding`);
    }
    expect(logFiles()).toHaveLength(4);
  });

  it('honours keepFiles: 0 by dropping the file instead of archiving it', () => {
    configureLogger({ keepFiles: 0 });
    for (let index = 0; index < 200; index += 1) log('info', `line ${index} padding padding padding padding`);
    expect(logFiles()).toEqual(['athena.log']);
  });

  it('exposes the active limits', () => {
    configureLogger({ maxFileBytes: 5_000_000, keepFiles: 7 });
    expect(getLogLimits()).toEqual({ maxFileBytes: 5_000_000, keepFiles: 7 });
  });

  it('enforces a floor on the cap so rotation cannot thrash', () => {
    configureLogger({ maxFileBytes: 1 });
    expect(getLogLimits().maxFileBytes).toBe(1024);
  });

  it('writes into the configured file name', () => {
    configureLogger({ file: 'custom.log' });
    log('info', 'named file');
    expect(existsSync(join(DATA_DIR, 'custom.log'))).toBe(true);
    rmSync(join(DATA_DIR, 'custom.log'), { force: true });
  });
});
