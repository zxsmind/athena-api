import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getDataPath } from './storage.js';

/**
 * The admin secret guards key management (`/v1/keys`) and usage analytics
 * (`/v1/analytics`). Those routes used to trust the source address alone, so
 * anyone on the same private network — cafe wifi, a shared VPS net, a tailnet
 * — could mint API keys. Now they need this secret too.
 *
 * Resolution order: `ATHENA_ADMIN_KEY` env first (compose/secret managers),
 * then the `admin.key` file in the data directory, generated on first boot
 * and printed once. The file holds mode 0600; anyone who can read it already
 * owns the machine, same as `settings.yaml` with its provider keys.
 */

const MIN_LENGTH = 16;

let cached: string | null = null;

export function adminKeyFile(): string {
  return getDataPath('admin.key');
}

function fromFile(): string | null {
  try {
    const raw = readFileSync(adminKeyFile(), 'utf8').trim();
    return raw.length >= MIN_LENGTH ? raw : null;
  } catch {
    return null;
  }
}

function generate(): string {
  const fresh = `adm_${randomBytes(32).toString('base64url')}`;
  mkdirSync(dirname(adminKeyFile()), { recursive: true });
  writeFileSync(adminKeyFile(), `${fresh}\n`, { mode: 0o600 });
  /* Printed once, at creation. After that the only copy lives in the file
     (and the operator's notes). Losing it means rotating, not recovering. */
  process.stderr.write(
    '\n  Athena admin key (shown once — store it, /v1/keys and /v1/analytics need it):\n' +
    `\n    ${fresh}\n\n`,
  );
  return fresh;
}

export function getAdminKey(): string {
  if (cached) return cached;
  const env = (process.env.ATHENA_ADMIN_KEY ?? '').trim();
  if (env.length >= MIN_LENGTH) {
    cached = env;
    return cached;
  }
  cached = fromFile() ?? generate();
  return cached;
}

/** Constant-time compare; length leak is irrelevant for a fixed secret. */
export function isAdminKey(value: string | undefined | null): boolean {
  if (!value) return false;
  const expected = Buffer.from(getAdminKey());
  const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Mints a fresh secret, replacing env/file for this process. Shown once. */
export function rotateAdminKey(): string {
  const fresh = `adm_${randomBytes(32).toString('base64url')}`;
  mkdirSync(dirname(adminKeyFile()), { recursive: true });
  writeFileSync(adminKeyFile(), `${fresh}\n`, { mode: 0o600 });
  cached = fresh;
  process.stderr.write(`\n  New Athena admin key (shown once):\n\n    ${fresh}\n\n`);
  return fresh;
}

/** Clears the process cache; used in tests. */
export function resetAdminKeyCache(): void {
  cached = null;
}
