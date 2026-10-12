import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dump, load } from 'js-yaml';

/* How long an atomic write waits out a transient target lock before giving
   up: Windows (editor, AV, sync client) can hold the destination for a beat,
   and nothing else in the process needs that beat. */
const RENAME_ATTEMPTS = 4;
const RENAME_RETRY_MS = 100;

function sleepSync(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) {
    /* Busy on purpose: the thing being waited on is a lock held elsewhere,
       and no timer in this process can release it faster. */
  }
}

export type StructuredFormat = 'yaml' | 'json';

/** Format by file extension. `.yaml` and `.yml` parse as YAML. */
export function formatOf(path: string): StructuredFormat {
  return /\.ya?ml$/i.test(path) ? 'yaml' : 'json';
}

function parseText(text: string, path: string): unknown {
  if (formatOf(path) !== 'yaml') return JSON.parse(text) as unknown;
  /* An empty file means "no overrides". YAML rejects an empty document, so it
     is handled here instead of surfacing as a config error. */
  if (text.trim().length === 0) return {};
  return (load(text) ?? {}) as unknown;
}

/** Reads a YAML or JSON file by extension. A missing file reads as `{}`. */
export function readStructuredFile(path: string): unknown {
  if (!existsSync(path)) return {};
  try {
    const parsed = parseText(readFileSync(path, 'utf-8'), path);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    const format = formatOf(path) === 'yaml' ? 'YAML' : 'JSON';
    throw new Error(`Config file at ${path} is not valid ${format}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Writes a value as YAML or JSON by extension, creating parent directories. */
export function writeStructuredFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = formatOf(path) === 'yaml'
    ? dump(value, { noRefs: true, lineWidth: 120 })
    : JSON.stringify(value, null, 2);
  /* Written beside the target and renamed into place: the rename is atomic on
     POSIX and on Windows (same volume), so a crash mid-write cannot leave the
     file half-written. settings.yaml holds provider keys; a truncated file is
     not a recoverable state for that. */
  const temp = `${path}.tmp`;
  writeFileSync(temp, text, 'utf-8');
  /* NTFS fails the rename while another process holds the destination open
     (editor lock, AV scan, sync client); POSIX succeeds there unconditionally.
     The rename is still atomic wherever it succeeds, so this retries only the
     transient shape of the failure — a genuine permission or disk problem
     throws through unchanged after the wait. */
  let lastError: unknown = null;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
      lastError = error;
      sleepSync(RENAME_RETRY_MS * (attempt + 1));
    }
  }
  throw lastError;
}
