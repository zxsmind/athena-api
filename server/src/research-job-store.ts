import { getDatabase } from './storage.js';

export interface PersistedResearchJob {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  data: string;
}

const database = getDatabase();

database.exec(`
  CREATE TABLE IF NOT EXISTS research_jobs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_research_jobs_created ON research_jobs(created_at DESC);
  CREATE TABLE IF NOT EXISTS research_job_events (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY(job_id, seq),
    FOREIGN KEY(job_id) REFERENCES research_jobs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_research_events_job_seq ON research_job_events(job_id, seq);
`);

export function saveResearchJobSnapshot(job: PersistedResearchJob): void {
  database.prepare(`
    INSERT INTO research_jobs(id, created_at, updated_at, status, data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = excluded.updated_at,
      status = excluded.status,
      data = excluded.data
  `).run(job.id, job.createdAt, job.updatedAt, job.status, job.data);
}

export function appendResearchJobEvent(jobId: string, seq: number, at: string, data: string): void {
  database.prepare(
    'INSERT OR REPLACE INTO research_job_events(job_id, seq, at, data) VALUES (?, ?, ?, ?)',
  ).run(jobId, seq, at, data);
}

export function saveResearchJobWithEvent(
  job: PersistedResearchJob,
  event: { seq: number; at: string; data: string },
  firstRetainedSeq: number,
): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`
      INSERT INTO research_jobs(id, created_at, updated_at, status, data)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        status = excluded.status,
        data = excluded.data
    `).run(job.id, job.createdAt, job.updatedAt, job.status, job.data);
    database.prepare(
      'INSERT OR REPLACE INTO research_job_events(job_id, seq, at, data) VALUES (?, ?, ?, ?)',
    ).run(job.id, event.seq, event.at, event.data);
    database.prepare('DELETE FROM research_job_events WHERE job_id = ? AND seq < ?').run(job.id, firstRetainedSeq);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function pruneResearchJobEvents(jobId: string, firstRetainedSeq: number): void {
  database.prepare('DELETE FROM research_job_events WHERE job_id = ? AND seq < ?').run(jobId, firstRetainedSeq);
}

export function loadRecentResearchJobs(limit: number): PersistedResearchJob[] {
  return database.prepare(
    'SELECT id, created_at AS createdAt, updated_at AS updatedAt, status, data FROM research_jobs ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as unknown as PersistedResearchJob[];
}

export function loadResearchJobEvents(jobId: string, limit: number): string[] {
  const rows = database.prepare(
    'SELECT data FROM research_job_events WHERE job_id = ? ORDER BY seq DESC LIMIT ?',
  ).all(jobId, limit) as Array<{ data: string }>;
  return rows.reverse().map((row) => row.data);
}

export function deletePersistedResearchJob(id: string): void {
  database.prepare('DELETE FROM research_jobs WHERE id = ?').run(id);
}
