import { describe, expect, it } from 'vitest';
import { resolveDataDir, APP_DIR_NAME, type DataDirEnv } from '../src/data-dir.js';

const win = (env: DataDirEnv) => resolveDataDir(env, 'win32', 'C:\\Users\\dev');
const linux = (env: DataDirEnv, home = '/home/dev') => resolveDataDir(env, 'linux', home);
const mac = (env: DataDirEnv, home = '/Users/dev') => resolveDataDir(env, 'darwin', home);

describe('explicit ATHENA_DATA_DIR wins on every platform', () => {
  it('is used verbatim on each platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const dir = resolveDataDir({ ATHENA_DATA_DIR: '/srv/athena' }, platform, '/home/dev');
      expect(dir.path).toContain('srv');
      expect(dir.source).toBe('explicit');
      expect(dir.reason).toBe('ATHENA_DATA_DIR');
    }
  });

  it('ignores an empty or whitespace value', () => {
    const dir = resolveDataDir({ ATHENA_DATA_DIR: '   ', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'win32', 'C:\\Users\\dev');
    expect(dir.source).toBe('platform');
  });
});

describe('windows', () => {
  it('prefers LOCALAPPDATA', () => {
    const dir = win({ LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' });
    expect(dir.path).toBe(`C:\\Users\\dev\\AppData\\Local\\${APP_DIR_NAME}`);
    expect(dir.reason).toBe('%LOCALAPPDATA%');
  });

  it('falls back to APPDATA when LOCALAPPDATA is missing', () => {
    const dir = win({ APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' });
    expect(dir.path).toBe(`C:\\Users\\dev\\AppData\\Roaming\\${APP_DIR_NAME}`);
  });

  it('derives the roaming path from USERPROFILE when APPDATA is absent', () => {
    const dir = resolveDataDir({ USERPROFILE: 'C:\\Users\\dev' }, 'win32', 'C:\\Users\\dev');
    expect(dir.path).toBe(`C:\\Users\\dev\\AppData\\Roaming\\${APP_DIR_NAME}`);
  });

  it('falls back to temp with no Windows environment at all', () => {
    const dir = resolveDataDir({}, 'win32', null);
    expect(dir.source).toBe('temp');
    /* Never invents a POSIX path under a Windows profile. */
    expect(dir.path).not.toMatch(/\.local/);
    expect(dir.path).not.toMatch(/Application Support/);
  });

  it('still uses the profile path on Windows when only USERPROFILE is set', () => {
    const dir = resolveDataDir({ USERPROFILE: 'C:\\dev' }, 'win32', 'C:\\dev');
    expect(dir.path).toContain('AppData');
    expect(dir.path).toContain(APP_DIR_NAME);
  });
});

describe('macos', () => {
  it('uses Application Support', () => {
    const dir = mac({});
    expect(dir.path).toBe(`/Users/dev/Library/Application Support/${APP_DIR_NAME}`);
    expect(dir.reason).toBe('~/Library/Application Support');
  });

  it('falls back to temp when there is no home directory', () => {
    expect(mac({}, null).source).toBe('temp');
  });

  it('ignores XDG_DATA_HOME because macOS has its own convention', () => {
    const dir = mac({ XDG_DATA_HOME: '/custom' });
    expect(dir.path).toContain('Application Support');
  });
});

describe('linux and other unix', () => {
  it('uses XDG_DATA_HOME when set', () => {
    const dir = linux({ XDG_DATA_HOME: '/custom/xdg' });
    expect(dir.path).toBe(`/custom/xdg/${APP_DIR_NAME}`);
    expect(dir.reason).toBe('$XDG_DATA_HOME');
  });

  it('falls back to ~/.local/share', () => {
    const dir = linux({});
    expect(dir.path).toBe(`/home/dev/.local/share/${APP_DIR_NAME}`);
    expect(dir.reason).toBe('~/.local/share');
  });

  it('falls back to temp when there is no home directory', () => {
    const dir = linux({}, null);
    expect(dir.source).toBe('temp');
    expect(dir.reason).toMatch(/temp/i);
  });
});

describe('the source tree is never a fallback', () => {
  it('never returns a path inside the repository', () => {
    const cases: Array<[NodeJS.Platform, DataDirEnv, string | null]> = [
      ['win32', {}, 'C:\\dev'],
      ['win32', { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'C:\\Users\\dev'],
      ['darwin', {}, '/Users/dev'],
      ['linux', {}, '/home/dev'],
      ['linux', { XDG_DATA_HOME: '/custom' }, '/home/dev'],
    ];
    for (const [platform, env, home] of cases) {
      const dir = resolveDataDir(env, platform, home);
      expect(dir.path).not.toMatch(/server[\\/]data/);
      expect(dir.path).not.toMatch(/athena-002/);
    }
  });
});