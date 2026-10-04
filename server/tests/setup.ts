import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* NOTE: this file must not statically import anything from src/. Static
   imports are hoisted and would load storage.ts before the assignment below,
   freezing DATA_DIR to the real data directory for every test file. */

/**
 * Points every test file at its own SQLite database.
 *
 * `storage.ts` resolves `ATHENA_DATA_DIR` when it is first imported, and this
 * setup file runs before the test file's imports, so the assignment takes effect.
 *
 * Without it, parallel test files share one database. Two failure modes follow:
 * writers collide on SQLite locks, and importing `research-jobs.js` marks every
 * leftover `queued` job as `failed` — including a job another worker has just
 * created. It also means the suite no longer writes to the developer's real
 * data directory.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'athena-test-'));
process.env.ATHENA_DATA_DIR = dataDir;

afterAll(async () => {
  /* Dynamic import on purpose: static imports run before the DATA_DIR
     assignment above and would defeat the isolation. Windows will not delete
     a directory that still holds an open handle, so the database is closed
     before its files are removed. Cleanup is best-effort. */
  const { closeDatabase } = await import('../src/storage.js');
  closeDatabase();
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* leave the temp directory behind rather than fail the suite */
  }
});
