import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { getDataPath, DATA_DIR } from './storage.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Destination file name, resolved inside the data directory. */
  file?: string;
  /** Rotate once the active file reaches this size. */
  maxFileBytes?: number;
  /** Rotated files kept: `athena.1.log`, `athena.2.log`, ... */
  keepFiles?: number;
  /** Also write to stdout. */
  echoToStdout?: boolean;
  /** Lowest level that gets written. */
  level?: LogLevel;
}

interface LoggerState {
  path: string;
  maxFileBytes: number;
  keepFiles: number;
  echoToStdout: boolean;
  level: LogLevel;
  size: number;
}

const state: LoggerState = {
  path: getDataPath('athena.log'),
  maxFileBytes: 10 * 1024 * 1024,
  keepFiles: 3,
  echoToStdout: false,
  level: 'info',
  size: 0,
};

function currentSize(): number {
  try {
    return existsSync(state.path) ? statSync(state.path).size : 0;
  } catch {
    return 0;
  }
}

/** Applies config-driven limits. Called once at startup and by the CLI. */
export function configureLogger(options: LoggerOptions = {}): void {
  if (options.file) state.path = getDataPath(options.file);
  if (options.maxFileBytes !== undefined) state.maxFileBytes = Math.max(1024, options.maxFileBytes);
  if (options.keepFiles !== undefined) state.keepFiles = Math.max(0, options.keepFiles);
  if (options.echoToStdout !== undefined) state.echoToStdout = options.echoToStdout;
  if (options.level !== undefined) state.level = options.level;
  state.size = currentSize();
}

export function getLogFilePath(): string {
  return state.path;
}

export function getLogLimits(): { maxFileBytes: number; keepFiles: number } {
  return { maxFileBytes: state.maxFileBytes, keepFiles: state.keepFiles };
}

/**
 * Shifts rotated files up by one and starts a fresh active file. With
 * `keepFiles: 3` the set is `athena.log`, `athena.1.log`, `athena.2.log`,
 * `athena.3.log`; anything older is deleted.
 */
function rotateIfNeeded(incoming: number): void {
  if (state.size + incoming <= state.maxFileBytes) return;
  for (let index = state.keepFiles; index >= 2; index -= 1) {
    rmSync(rotatedPath(index), { force: true });
    if (existsSync(rotatedPath(index - 1))) renameSync(rotatedPath(index - 1), rotatedPath(index));
  }
  if (state.keepFiles >= 1) {
    if (existsSync(state.path)) renameSync(state.path, rotatedPath(1));
  } else {
    rmSync(state.path, { force: true });
  }
  state.size = 0;
}

function rotatedPath(index: number): string {
  const dot = state.path.lastIndexOf('.');
  const base = dot > 0 ? state.path.slice(0, dot) : state.path;
  const ext = dot > 0 ? state.path.slice(dot) : '';
  return `${base}.${index}${ext}`;
}

/** Appends one line. Never throws: logging must not break a request. */
export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return;
  const detail = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${detail}\n`;
  if (state.echoToStdout) process.stdout.write(line);
  try {
    rotateIfNeeded(Buffer.byteLength(line));
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(state.path, line, 'utf-8');
    state.size += Buffer.byteLength(line);
  } catch { /* logging is best effort */ }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
};
