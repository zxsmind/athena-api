import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { getDataPath, getDatabase, reclaimDatabaseSpace } from '../src/storage.js';

/**
 * A database created before incremental vacuum existed: `auto_vacuum` is a
 * header flag, so it cannot be switched on by setting the pragma alone — only
 * a VACUUM rebuilds the file. The migration is what reclaims the pages that
 * never came back, which is how a file reaches 569 MB holding 600 KB of rows.
 *
 * The legacy file is seeded before the first `getDatabase()` call: the
 * connection is a per-process singleton, and after it opens there is no second
 * chance to have a database that predates the mode.
 */
function seedLegacyDatabase(): { beforeBytes: number } {
  mkdirSync(getDataPath(), { recursive: true });
  const path = getDataPath('athena.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec('PRAGMA journal_mode = WAL;');
  legacy.exec('CREATE TABLE filler (id INTEGER PRIMARY KEY, blob TEXT)');
  const insert = legacy.prepare('INSERT INTO filler (blob) VALUES (?)');
  legacy.exec('BEGIN');
  for (let i = 0; i < 6000; i += 1) insert.run('x'.repeat(800));
  legacy.exec('COMMIT');
  legacy.exec('DELETE FROM filler');
  legacy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const beforeBytes = statSync(path).size;
  legacy.close();
  return { beforeBytes };
}

describe('incremental vacuum', () => {
  it('converts a database that predates it and returns its dead pages', () => {
    const { beforeBytes } = seedLegacyDatabase();

    const db = getDatabase();

    const mode = db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number };
    expect(mode.auto_vacuum).toBe(2);

    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const afterBytes = statSync(getDataPath('athena.sqlite')).size;
    /* The rows are gone and so are the pages they lived in: what remains is
       the schema, not the 6000 rows that were never reclaimed before. */
    expect(afterBytes).toBeLessThan(beforeBytes / 10);
    expect(afterBytes).toBeLessThan(1024 * 1024);
  });

  it('reclaims nothing when the freelist is already empty', () => {
    const db = getDatabase();
    const freelist = db.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
    expect(freelist.freelist_count).toBe(0);
    expect(reclaimDatabaseSpace(db)).toBe(0);
  });
});
