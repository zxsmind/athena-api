import { accessSync, constants, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { resolveDataDir, type ResolvedDataDir } from './data-dir.js';

export const resolvedDataDir: ResolvedDataDir = resolveDataDir(process.env, process.platform, safeHome());
export const DATA_DIR = resolvedDataDir.path;
const DATABASE_PATH = join(DATA_DIR, 'athena.sqlite');

let database: DatabaseSync | null = null;

/** `homedir()` throws on some minimal container images; treat that as unknown. */
function safeHome(): string | null {
  try {
    return homedir() || null;
  } catch {
    return null;
  }
}

export function getDataPath(...parts: string[]): string {
  return resolve(DATA_DIR, ...parts);
}

/**
 * Confirms the data directory exists and is writable.
 *
 * Fails with an actionable message instead of a bare EACCES from deep inside
 * SQLite, because the usual cause is a read-only checkout or a container
 * started without a volume on `/data`.
 */
export function assertDataDirWritable(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    accessSync(DATA_DIR, constants.W_OK);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The data directory is not writable: ${DATA_DIR}\n` +
      `  Resolved from: ${resolvedDataDir.reason}\n` +
      `  ${detail}\n\n` +
      `  Set ATHENA_DATA_DIR to a writable path, for example:\n` +
      `    ATHENA_DATA_DIR=/var/lib/athena npm start`,
    );
  }
}

export function getDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(DATA_DIR, { recursive: true });
  database = new DatabaseSync(DATABASE_PATH);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return database;
}

export function closeDatabase(): void {
  if (!database) return;
  try {
    database.close();
  } catch { /* already closed */ }
  database = null;
}