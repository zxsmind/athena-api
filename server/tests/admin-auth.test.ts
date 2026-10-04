import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import {
  adminKeyFile,
  getAdminKey,
  isAdminKey,
  resetAdminKeyCache,
  rotateAdminKey,
} from '../src/admin-auth.js';

const ENV_KEY = 'test-admin-key-0123456789abcdef';

beforeEach(() => {
  resetAdminKeyCache();
  delete process.env.ATHENA_ADMIN_KEY;
});

afterEach(() => {
  resetAdminKeyCache();
  delete process.env.ATHENA_ADMIN_KEY;
});

describe('admin key', () => {
  it('prefers the environment over the file', () => {
    process.env.ATHENA_ADMIN_KEY = ENV_KEY;
    expect(getAdminKey()).toBe(ENV_KEY);
    expect(isAdminKey(ENV_KEY)).toBe(true);
    expect(isAdminKey('wrong')).toBe(false);
  });

  it('ignores an env value that is too short to be a secret', () => {
    process.env.ATHENA_ADMIN_KEY = 'short';
    const key = getAdminKey();
    expect(key).not.toBe('short');
    expect(key.startsWith('adm_')).toBe(true);
    rmSync(adminKeyFile(), { force: true });
    resetAdminKeyCache();
  });

  it('generates once and then reads back the same file value', () => {
    rmSync(adminKeyFile(), { force: true });
    const first = getAdminKey();
    expect(first.startsWith('adm_')).toBe(true);
    expect(existsSync(adminKeyFile())).toBe(true);
    resetAdminKeyCache();
    expect(getAdminKey()).toBe(first);
  });

  it('rotation invalidates the previous key', () => {
    process.env.ATHENA_ADMIN_KEY = ENV_KEY;
    const rotated = rotateAdminKey();
    expect(rotated).not.toBe(ENV_KEY);
    expect(isAdminKey(rotated)).toBe(true);
    expect(isAdminKey(ENV_KEY)).toBe(false);
    rmSync(adminKeyFile(), { force: true });
  });

  it('rejects empty and length-mismatched values without throwing', () => {
    process.env.ATHENA_ADMIN_KEY = ENV_KEY;
    expect(isAdminKey(undefined)).toBe(false);
    expect(isAdminKey('')).toBe(false);
    expect(isAdminKey(ENV_KEY + 'x')).toBe(false);
  });
});
