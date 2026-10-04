import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataPath } from '../src/storage.js';

const SETTINGS = getDataPath('settings.yaml');

/**
 * The settings file holds API keys. A parse failure must never replace it with
 * defaults: that is how a working configuration was destroyed once, because a
 * read error fell through to a save. The load must report and keep the file.
 */
describe('settings file is never destroyed by a read failure', () => {
  const backup = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf-8') : null;

  afterEach(() => {
    if (backup === null) {
      if (existsSync(SETTINGS)) rmSync(SETTINGS);
      return;
    }
    writeFileSync(SETTINGS, backup, 'utf-8');
  });

  it('leaves an unparseable file untouched and still returns settings', async () => {
    /* Each import reads the file once and caches, so the module is imported
       after the file is broken. */
    const broken = '{ this is not: valid yaml';
    writeFileSync(SETTINGS, broken, 'utf-8');
    rmSync(join(getDataPath('.'), 'noop'), { force: true });

    /* The cache lives in the module, so the cache is dropped explicitly rather
       than by re-importing with a query string, which the bundler rejects. */
    const module = await import('../src/settings-store.js');
    module.resetSettingsCache();
    const settings = module.loadSettings();

    /* The important part: the file is still the one that was there. */
    expect(readFileSync(SETTINGS, 'utf-8')).toBe(broken);
    /* And the caller still gets a usable object rather than a crash. */
    expect(settings.providers).toBeDefined();
    expect(Array.isArray(settings.providerOrder)).toBe(true);
  });
});