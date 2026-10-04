import { tmpdir } from 'node:os';
import { resolve, win32, posix, type PlatformPath } from 'node:path';

/** Folder name used under every platform data root. */
export const APP_DIR_NAME = 'athena';

export interface DataDirEnv {
  ATHENA_DATA_DIR?: string | undefined;
  LOCALAPPDATA?: string | undefined;
  APPDATA?: string | undefined;
  XDG_DATA_HOME?: string | undefined;
  HOME?: string | undefined;
  USERPROFILE?: string | undefined;
}

export type DataDirSource = 'explicit' | 'platform' | 'temp';

export interface ResolvedDataDir {
  path: string;
  source: DataDirSource;
  /** Human-readable reason, useful in `athena about` and error messages. */
  reason: string;
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Resolves where runtime state lives.
 *
 * Order:
 *   1. `ATHENA_DATA_DIR` when set. This is how Docker, systemd, and any
 *      deployment pin the location, and it is the only supported way to put
 *      state on a specific volume.
 *   2. The platform convention for per-user application data: `%LOCALAPPDATA%`
 *      on Windows, `~/Library/Application Support` on macOS, and
 *      `$XDG_DATA_HOME` or `~/.local/share` elsewhere.
 *   3. The system temp directory, only when no home directory can be found.
 *
 * The source tree is never a fallback. A checkout can be read-only, replaced by
 * a fresh `git clone`, or thrown away on a notebook runtime, and runtime state
 * must survive none of those. Colab, Docker, and a bare `npm ci && npm start`
 * all work with the resolved path without any configuration.
 *
 * Paths are built with the separator set of the requested platform rather than
 * the host's, so the result is correct for the platform being described and not
 * merely for the machine running the test.
 */
export function resolveDataDir(
  env: DataDirEnv,
  platform: NodeJS.Platform = process.platform,
  home: string | null = null,
): ResolvedDataDir {
  const pathApi: PlatformPath = platform === 'win32' ? win32 : posix;

  const explicit = firstNonEmpty(env.ATHENA_DATA_DIR);
  if (explicit) {
    return {
      /* A relative override is anchored to the working directory so
         `--prefix`-style invocations stay predictable. */
      path: pathApi.isAbsolute(explicit) ? pathApi.normalize(explicit) : resolve(process.cwd(), explicit),
      source: 'explicit',
      reason: 'ATHENA_DATA_DIR',
    };
  }

  if (platform === 'win32') {
    const localAppData = firstNonEmpty(env.LOCALAPPDATA);
    if (localAppData) {
      return { path: pathApi.join(localAppData, APP_DIR_NAME), source: 'platform', reason: '%LOCALAPPDATA%' };
    }
    const appData = firstNonEmpty(env.APPDATA, env.USERPROFILE ? pathApi.join(env.USERPROFILE, 'AppData', 'Roaming') : undefined);
    if (appData) {
      return { path: pathApi.join(appData, APP_DIR_NAME), source: 'platform', reason: '%APPDATA%' };
    }
    /* Windows without any of its data variables is not a Linux machine: fall
       through to temp rather than inventing a POSIX path under the profile. */
  } else if (platform === 'darwin') {
    if (home) {
      return {
        path: pathApi.join(home, 'Library', 'Application Support', APP_DIR_NAME),
        source: 'platform',
        reason: '~/Library/Application Support',
      };
    }
  } else {
    const xdg = firstNonEmpty(env.XDG_DATA_HOME);
    if (xdg) {
      return { path: pathApi.join(xdg, APP_DIR_NAME), source: 'platform', reason: '$XDG_DATA_HOME' };
    }
    if (home) {
      return { path: pathApi.join(home, '.local', 'share', APP_DIR_NAME), source: 'platform', reason: '~/.local/share' };
    }
  }

  return {
    path: pathApi.join(tmpdir(), APP_DIR_NAME),
    source: 'temp',
    reason: 'no writable home directory found, using the temp directory',
  };
}