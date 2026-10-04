import { loadSettings, type SettingsStore } from './settings-store.js';
import { assertDataDirWritable, getDataPath } from './storage.js';

export interface ConfigAudit {
  ready: boolean;
  providers: string[];
  searches: string[];
  /** Human-readable reasons the server must not start. Empty when ready. */
  blockers: string[];
  /** Non-fatal gaps worth surfacing. Empty when nothing is missing. */
  warnings: string[];
}

/**
 * Readiness is decided from settings alone, never from a network probe: an
 * LLM provider counts as configured when it is enabled and has at least one
 * key, and the catalog is validated lazily on first use.
 */
export function auditConfiguration(settings: SettingsStore): ConfigAudit {
  const providers = Object.entries(settings.providers)
    .filter(([, state]) => state.enabled && (state.keys.length > 0 || state.anonymous === true))
    .map(([id]) => id);
  const searches = Object.entries(settings.searchProviders)
    .filter(([, state]) => state.keys.length > 0)
    .map(([id]) => id);

  const blockers: string[] = [];
  if (providers.length === 0) {
    blockers.push('No LLM provider is configured. Add one with an API key under `providers` in settings.yaml.');
  }
  return {
    ready: blockers.length === 0,
    providers,
    searches,
    blockers,
    warnings: searches.length === 0
      ? ['No search backend is configured. /v1/search and /v1/research will return 503 until one is added.']
      : [],
  };
}

/**
 * Startup contract: an unconfigured server refuses to boot and says why.
 * A server that answers 200 on /v1/health while being unable to do any work is
 * worse than one that does not start, so this runs before the listener opens.
 */
export function assertConfigured(): ConfigAudit {
  /* Fails first on an unwritable data directory: a read-only checkout or a
     container started without a volume on /data is the more common failure and
     the more confusing one. */
  assertDataDirWritable();

  const audit = auditConfiguration(loadSettings());
  if (audit.ready) return audit;

  const lines = [
    '',
    '  Athena is not configured yet. Nothing was started.',
    '',
    ...audit.blockers.map((reason) => `  ✖ ${reason}`),
    ...audit.warnings.map((reason) => `  ! ${reason}`),
    '',
    '  Configure it with either of these:',
    '',
    '    npm run cli -- setup          from inside server/ (works right now)',
    '    athena setup                  after `npm link` inside server/',
    '',
    '  Or edit the file directly:',
    '',
    `    ${getDataPath('settings.yaml')}`,
    '',
    '  Then start the server again.',
    '',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exit(1);
}
