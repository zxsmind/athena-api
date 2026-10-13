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
  /* Before anything writes page 1: on a fresh file this is what makes the
     header say INCREMENTAL from the first page, so it costs nothing later. On
     an existing file the pragma is a no-op — see ensureIncrementalVacuum. */
  database.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  ensureIncrementalVacuum(database);
  return database;
}

/** SQLite's `auto_vacuum` value for incremental mode. */
const AUTO_VACUUM_INCREMENTAL = 2;

/**
 * Turns on incremental vacuum for a database created before it existed, and
 * reclaims what has already piled up.
 *
 * `auto_vacuum` is a header flag. Setting it on a database that has been
 * written to does nothing at all until a VACUUM rebuilds the file — measured,
 * not assumed: the pragma stays at 0, and only `set + VACUUM` makes it 2. The
 * same VACUUM empties the freelist on the way through, so the migration also
 * fixes the file it is running for: a database can sit at 569 MB holding 600 KB
 * of rows, because nothing ever hands those pages back.
 */
function ensureIncrementalVacuum(db: DatabaseSync): void {
  try {
    const row = db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number } | undefined;
    if (row?.auto_vacuum === AUTO_VACUUM_INCREMENTAL) return;
    const startedAt = Date.now();
    db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    db.exec('VACUUM');
    console.log(`[storage] incremental vacuum enabled, dead pages reclaimed in ${Date.now() - startedAt}ms`);
  } catch (error) {
    /* A locked database (another process holds it) fails here and retries on
       the next start; the server stays usable without it. */
    console.error('[storage] incremental vacuum not enabled:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Hands every dead page back to the file system and checkpoints the log, so the
 * size on disk matches the data that is actually there.
 *
 * Called after a retention sweep, never on a request path: it takes a write
 * lock, and there is nothing to reclaim when the freelist is already empty.
 * Returns the pages reclaimed, or 0 when there was nothing to do.
 */
export function reclaimDatabaseSpace(db: DatabaseSync = getDatabase()): number {
  try {
    const row = db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined;
    const deadPages = row?.freelist_count ?? 0;
    if (deadPages === 0) return 0;
    /* Without the checkpoint the shrunken pages sit in the WAL and the file on
       disk keeps its old size. PASSIVE never blocks a reader. */
    db.exec('PRAGMA incremental_vacuum;');
    db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    return deadPages;
  } catch (error) {
    console.error('[storage] reclaiming space failed:', error instanceof Error ? error.message : String(error));
    return 0;
  }
}

export function closeDatabase(): void {
  if (!database) return;
  try {
    database.close();
  } catch { /* already closed */ }
  database = null;
}