import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { getDatabase } from './storage.js';
import { applyRateLimit, RATE_LIMIT_IDLE_EVICTION_MS, type RateDecision, type RateLimitEntry } from './rate-limit.js';

export type KeyPlan = 'free' | 'paid' | 'enterprise';

/** A short, human-quotable public identifier such as `B4cK60vpFS9`. */
export type PublicKeyId = string;

export interface ApiKeyRecord {
  id: PublicKeyId;
  name: string;
  plan: KeyPlan;
  prefix: string;
  secretHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface DailyUsage {
  keyId: PublicKeyId;
  day: string;
  creditsUsed: number;
}

export interface ApiRequestRecord {
  at: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  apiKeyId: string | null;
}

export interface ApiUsageRollup {
  requests: number;
  errors: number;
  averageDurationMs: number;
  byDay: Array<{ day: string; requests: number; errors: number }>;
  byRoute: Array<{ route: string; requests: number; errors: number }>;
  byKey: Array<{ id: string; name: string; prefix: string; requests: number; errors: number }>;
}

/**
 * Key names are human labels: letters, digits, spaces, and inner punctuation
 * that survives a terminal. Leading, trailing, and repeated spaces collapse.
 */
export const KEY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._@/+&'-]*$/;
export const KEY_NAME_MAX_LENGTH = 80;

/** Collapses runs of spaces, trims, and returns `null` when the name is unusable. */
export function normalizeKeyName(raw: string): string | null {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (clean.length === 0 || clean.length > KEY_NAME_MAX_LENGTH) return null;
  return KEY_NAME_PATTERN.test(clean) ? clean : null;
}

const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex');

/**
 * Case-confusable characters are omitted so an id can be read aloud or copied
 * from a screenshot. `I`, `L`, `O` and `l` are dropped because they clash with
 * `1` and `0`. Digits are otherwise kept.
 */
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789';
export const PUBLIC_KEY_ID_LENGTH = 10;
const ID_ATTEMPTS = 24;

export function publicApiKey(record: ApiKeyRecord) {
  return {
    id: record.id,
    name: record.name,
    plan: record.plan,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

export type { PublicKeyId as PublicKeyIdType };

export class ApiPlatformStore {
  private readonly db: DatabaseSync;

  constructor(path?: string) {
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    } else {
      this.db = getDatabase();
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        prefix TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS api_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        method TEXT NOT NULL,
        route TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        api_key_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_requests_at ON api_requests(at);
      CREATE INDEX IF NOT EXISTS idx_api_requests_route_at ON api_requests(route, at);
      CREATE INDEX IF NOT EXISTS idx_api_requests_key_at ON api_requests(api_key_id, at);
      CREATE TABLE IF NOT EXISTS api_key_daily_usage (
        key_id TEXT NOT NULL,
        day TEXT NOT NULL,
        credits_used REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(key_id, day)
      );
      CREATE TABLE IF NOT EXISTS rate_limit_state (
        key_id TEXT PRIMARY KEY,
        second_tokens REAL NOT NULL,
        second_updated_at INTEGER NOT NULL,
        minute_window INTEGER NOT NULL,
        minute_count INTEGER NOT NULL,
        minute_previous INTEGER NOT NULL,
        touched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_slots (
        key_id TEXT PRIMARY KEY,
        active INTEGER NOT NULL
      );
    `);
    this.migrate();
  }

  /** Adds columns to tables created by earlier schema versions. */
  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'plan')) {
      this.db.exec("ALTER TABLE api_keys ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
    }
  }

  /**
   * Generates a short public id. Ambiguous characters are excluded and
   * collisions are retried against the unique primary key.
   */
  private newPublicId(): PublicKeyId {
    const exists = this.db.prepare('SELECT 1 FROM api_keys WHERE id = ?');
    for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
      const bytes = randomBytes(PUBLIC_KEY_ID_LENGTH);
      let id = '';
      for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (!exists.get(id)) return id;
    }
    throw new Error('Could not allocate a unique public key id.');
  }

  createApiKey(name: string, plan: KeyPlan): { record: ApiKeyRecord; secret: string } {
    const cleanName = normalizeKeyName(name);
    if (!cleanName) {
      throw new Error(
        `Key name is required: 1-${KEY_NAME_MAX_LENGTH} characters, letters, digits, and spaces.`,
      );
    }
    const secret = `ath_${randomBytes(32).toString('base64url')}`;
    const record: ApiKeyRecord = {
      id: this.newPublicId(),
      name: cleanName,
      plan,
      prefix: secret.slice(0, 12),
      secretHash: digest(secret),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.db.prepare(
      'INSERT INTO api_keys(id, name, plan, prefix, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(record.id, record.name, record.plan, record.prefix, record.secretHash, record.createdAt);
    return { record, secret };
  }

  private rowToRecord(row: {
    id: string; name: string; plan: string; prefix: string; secret_hash: string;
    created_at: string; last_used_at: string | null; revoked_at: string | null;
  }): ApiKeyRecord {
    return {
      id: row.id,
      name: row.name,
      plan: (row.plan === 'paid' || row.plan === 'enterprise' ? row.plan : 'free'),
      prefix: row.prefix,
      secretHash: row.secret_hash,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
    };
  }

  private static readonly SELECT_COLUMNS = 'id, name, plan, prefix, secret_hash, created_at, last_used_at, revoked_at';

  findActiveBySecret(secret: string | null): ApiKeyRecord | null {
    if (!secret || !secret.startsWith('ath_') || secret.length > 100) return null;
    const row = this.db.prepare(
      `SELECT ${ApiPlatformStore.SELECT_COLUMNS} FROM api_keys WHERE secret_hash = ? AND revoked_at IS NULL`,
    ).get(digest(secret)) as Parameters<ApiPlatformStore['rowToRecord']>[0] | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  listApiKeys(): ApiKeyRecord[] {
    const rows = this.db.prepare(
      `SELECT ${ApiPlatformStore.SELECT_COLUMNS} FROM api_keys ORDER BY created_at DESC`,
    ).all() as Array<Parameters<ApiPlatformStore['rowToRecord']>[0]>;
    return rows.map((row) => this.rowToRecord(row));
  }

  revokeApiKey(id: string, at = new Date().toISOString()): boolean {
    const result = this.db.prepare(
      'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    ).run(at, id);
    return Number(result.changes) > 0;
  }

  /** Moves a key to another plan. Takes effect on the next request. */
  setApiKeyPlan(id: string, plan: KeyPlan): boolean {
    const result = this.db.prepare('UPDATE api_keys SET plan = ? WHERE id = ?').run(plan, id);
    return Number(result.changes) > 0;
  }

  /** Renames a key. The public id and the secret are unaffected. */
  renameApiKey(id: string, name: string): boolean {
    const cleanName = normalizeKeyName(name);
    if (!cleanName) throw new Error('Key name must be 1-80 characters of letters, digits, and spaces.');
    const result = this.db.prepare('UPDATE api_keys SET name = ? WHERE id = ?').run(cleanName, id);
    return Number(result.changes) > 0;
  }

  touchApiKey(id: string, at = new Date().toISOString()): void {
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  /** Releases the connection. Required before removing the database file. */
  close(): void {
    this.db.close();
  }

  /**
   * Runs work inside a single-writer transaction. Concurrent processes serialize
   * here instead of racing on a read-modify-write cycle.
   */
  private transact<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Consumes one request for a key against its plan limits. The load-decide-store
   * cycle runs inside one transaction, so two processes cannot both spend the
   * last token of a bucket. Stale rows are evicted on the way through.
   */
  rateLimitTake(
    keyId: string,
    perSecond: number | null,
    perMinute: number | null,
    nowMs: number,
  ): RateDecision {
    return this.transact(() => {
      const row = this.db.prepare(
        `SELECT second_tokens, second_updated_at, minute_window, minute_count, minute_previous, touched_at
         FROM rate_limit_state WHERE key_id = ?`,
      ).get(keyId) as
        | { second_tokens: number; second_updated_at: number; minute_window: number; minute_count: number; minute_previous: number; touched_at: number }
        | undefined;
      const existing: RateLimitEntry | undefined = row
        ? {
            second: { tokens: row.second_tokens, updatedAt: row.second_updated_at },
            minute: { window: row.minute_window, count: row.minute_count, previous: row.minute_previous },
            touchedAt: row.touched_at,
          }
        : undefined;
      const { decision, entry } = applyRateLimit(existing, perSecond, perMinute, nowMs);
      this.db.prepare(
        `INSERT INTO rate_limit_state(key_id, second_tokens, second_updated_at, minute_window, minute_count, minute_previous, touched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key_id) DO UPDATE SET
           second_tokens = excluded.second_tokens,
           second_updated_at = excluded.second_updated_at,
           minute_window = excluded.minute_window,
           minute_count = excluded.minute_count,
           minute_previous = excluded.minute_previous,
           touched_at = excluded.touched_at`,
      ).run(keyId, entry.second.tokens, entry.second.updatedAt, entry.minute.window, entry.minute.count, entry.minute.previous, entry.touchedAt);
      this.db.prepare('DELETE FROM rate_limit_state WHERE touched_at < ?').run(nowMs - RATE_LIMIT_IDLE_EVICTION_MS);
      return decision;
    });
  }

  /**
   * Reserves one of the key's concurrent research job slots. Transactional, so
   * two processes cannot both take the last slot.
   */
  jobSlotAcquire(keyId: string, limit: number): boolean {
    return this.transact(() => {
      const row = this.db.prepare('SELECT active FROM job_slots WHERE key_id = ?').get(keyId) as
        | { active: number }
        | undefined;
      const active = row?.active ?? 0;
      if (active >= limit) return false;
      this.db.prepare(
        `INSERT INTO job_slots(key_id, active) VALUES (?, 1)
         ON CONFLICT(key_id) DO UPDATE SET active = job_slots.active + 1`,
      ).run(keyId);
      return true;
    });
  }

  /** Returns a slot taken by {@link jobSlotAcquire}. Never goes negative. */
  jobSlotRelease(keyId: string): void {
    this.transact(() => {
      const row = this.db.prepare('SELECT active FROM job_slots WHERE key_id = ?').get(keyId) as
        | { active: number }
        | undefined;
      if (!row || row.active <= 1) {
        this.db.prepare('DELETE FROM job_slots WHERE key_id = ?').run(keyId);
        return;
      }
      this.db.prepare('UPDATE job_slots SET active = active - 1 WHERE key_id = ?').run(keyId);
    });
  }

  /** Research jobs currently holding a slot for this key. */
  jobSlotCount(keyId: string): number {
    const row = this.db.prepare('SELECT active FROM job_slots WHERE key_id = ?').get(keyId) as
      | { active: number }
      | undefined;
    return row?.active ?? 0;
  }

  /** Credits already spent by a key on the given UTC day. */
  creditsUsedToday(keyId: string, day: string): number {
    const row = this.db.prepare(
      'SELECT credits_used FROM api_key_daily_usage WHERE key_id = ? AND day = ?',
    ).get(keyId, day) as { credits_used: number } | undefined;
    return row?.credits_used ?? 0;
  }

  /**
   * Debits a key's daily budget. The read-modify-write runs inside a
   * transaction so two concurrent requests cannot both pass the limit check.
   */
  debitDailyCredits(keyId: string, day: string, credits: number): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(
        'SELECT credits_used FROM api_key_daily_usage WHERE key_id = ? AND day = ?',
      ).get(keyId, day) as { credits_used: number } | undefined;
      const next = (row?.credits_used ?? 0) + credits;
      this.db.prepare(
        `INSERT INTO api_key_daily_usage(key_id, day, credits_used) VALUES (?, ?, ?)
         ON CONFLICT(key_id, day) DO UPDATE SET credits_used = excluded.credits_used`,
      ).run(keyId, day, next);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  dailyUsage(keyId: string, day: string): DailyUsage {
    return { keyId, day, creditsUsed: this.creditsUsedToday(keyId, day) };
  }

  recordRequest(record: ApiRequestRecord): void {
    this.db.prepare(
      'INSERT INTO api_requests(at, method, route, status, duration_ms, api_key_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(record.at, record.method, record.route, record.status, record.durationMs, record.apiKeyId);
  }

  summarize(days: number): ApiUsageRollup {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const totals = this.db.prepare(
      'SELECT COUNT(*) AS requests, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors, AVG(duration_ms) AS avg FROM api_requests WHERE at >= ?',
    ).get(since) as { requests: number; errors: number | null; avg: number | null };

    const byDay = this.db.prepare(
      'SELECT substr(at, 1, 10) AS day, COUNT(*) AS requests, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors FROM api_requests WHERE at >= ? GROUP BY day ORDER BY day',
    ).all(since) as Array<{ day: string; requests: number; errors: number | null }>;

    const byRoute = this.db.prepare(
      'SELECT route, COUNT(*) AS requests, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors FROM api_requests WHERE at >= ? GROUP BY route ORDER BY requests DESC',
    ).all(since) as Array<{ route: string; requests: number; errors: number | null }>;

    const byKey = this.db.prepare(
      `SELECT COALESCE(k.id, 'anonymous') AS id, COALESCE(k.name, 'anonymous') AS name, COALESCE(k.prefix, '') AS prefix,
              COUNT(r.id) AS requests,
              SUM(CASE WHEN r.status >= 400 THEN 1 ELSE 0 END) AS errors
       FROM api_requests r LEFT JOIN api_keys k ON k.id = r.api_key_id
       WHERE r.at >= ? GROUP BY COALESCE(k.id, 'anonymous') ORDER BY requests DESC`,
    ).all(since) as Array<{ id: string; name: string; prefix: string; requests: number; errors: number | null }>;

    return {
      requests: totals.requests ?? 0,
      errors: totals.errors ?? 0,
      averageDurationMs: Math.round(totals.avg ?? 0),
      byDay: byDay.map((row) => ({ day: row.day, requests: row.requests, errors: row.errors ?? 0 })),
      byRoute: byRoute.map((row) => ({ route: row.route, requests: row.requests, errors: row.errors ?? 0 })),
      byKey: byKey.map((row) => ({ ...row, errors: row.errors ?? 0 })),
    };
  }

  /** Most recent requests, newest first. Feeds `athena stats` and `athena keys`. */
  recentRequests(limit: number): ApiRequestRecord[] {
    const rows = this.db.prepare(
      `SELECT at, method, route, status, duration_ms AS durationMs, COALESCE(api_key_id, '') AS apiKeyId
       FROM api_requests ORDER BY at DESC LIMIT ?`,
    ).all(limit) as unknown as ApiRequestRecord[];
    return rows;
  }

  /** Credits spent per key for one UTC day. */
  creditsByKey(day: string): Array<{ keyId: string; name: string; plan: string; creditsUsed: number }> {
    const rows = this.db.prepare(
      `SELECT u.key_id AS keyId, COALESCE(k.name, '(deleted)') AS name, COALESCE(k.plan, '?') AS plan, u.credits_used AS creditsUsed
       FROM api_key_daily_usage u LEFT JOIN api_keys k ON k.id = u.key_id
       WHERE u.day = ? ORDER BY u.credits_used DESC`,
    ).all(day) as Array<{ keyId: string; name: string; plan: string; creditsUsed: number }>;
    return rows;
  }

  /** SQLite integrity result: `ok`, or the first problem page found. */
  integrityCheck(): string {
    const rows = this.db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    return rows[0]?.integrity_check ?? 'unknown';
  }

  /** True when a table exists. Other modules own their own tables, so a fresh
      database may not have them yet. */
  private hasTable(name: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    return row !== undefined;
  }

  /**
   * Drops state that belongs to processes which are gone: rate-limit buckets
   * idle past the eviction window and job slots whose job no longer runs.
   * Without a job table nothing can be running, so every slot is stale.
   */
  clearStaleState(): { rateLimitRows: number; jobSlotsCleared: number } {
    const rateLimit = this.db.prepare('DELETE FROM rate_limit_state WHERE touched_at < ?')
      .run(Date.now() - RATE_LIMIT_IDLE_EVICTION_MS);
    const slots = this.hasTable('research_jobs')
      ? this.db.prepare(
        `UPDATE job_slots SET active = 0
         WHERE key_id NOT IN (SELECT id FROM research_jobs WHERE status = 'running')`,
      ).run()
      : this.db.prepare('UPDATE job_slots SET active = 0').run();
    return {
      rateLimitRows: Number(rateLimit.changes),
      jobSlotsCleared: Number(slots.changes),
    };
  }
}
