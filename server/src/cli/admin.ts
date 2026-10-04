import { readFileSync } from 'node:fs';
import { getAdminKey, rotateAdminKey } from '../admin-auth.js';
import { ApiPlatformStore, KEY_NAME_PATTERN, normalizeKeyName, type KeyPlan } from '../api-platform-store.js';
import { getConfig } from '../config/load.js';
import { getLogFilePath, getLogLimits } from '../logger.js';
import { getDataPath, DATA_DIR, resolvedDataDir } from '../storage.js';
import { loadSettings } from '../settings-store.js';
import { getModelsDevSnapshot } from '../models-dev.js';
import { costFromUsage, readDatabaseInfo, readJobTotals, readSystemInfo } from './stats.js';
import { bytes, compactNumber, color, failure, info, kv, line, money, section, success, table, warn } from './ui.js';

export const PLANS: KeyPlan[] = ['free', 'paid', 'enterprise'];

/** Message shown by both the CLI and the API when a name is rejected. */
export const KEY_NAME_RULE = 'letters, digits, and spaces (max 80 characters)';

export function checkKeyName(raw: string): string | null {
  if (normalizeKeyName(raw)) return null;
  return `A key name is required: ${KEY_NAME_RULE}.`;
}

export { KEY_NAME_PATTERN };

export interface ServerState {
  reachable: boolean;
  status: number | null;
  detail: string;
}

export async function probeServer(port: number, timeoutMs = 3000): Promise<ServerState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: controller.signal });
    return { reachable: true, status: res.status, detail: res.ok ? 'healthy' : `unhealthy (${res.status})` };
  } catch {
    return { reachable: false, status: null, detail: 'not running' };
  } finally {
    clearTimeout(timer);
  }
}

/** Configuration plus liveness. The default landing command. */
export async function runStatus(): Promise<void> {
  const settings = loadSettings();
  const db = readDatabaseInfo();
  const server = await probeServer(settings.port);

  section('Service');
  kv('Bind', `${settings.host}:${settings.port}`);
  if (server.reachable) kv('Server', color.green(server.detail));
  else kv('Server', color.yellow(server.detail));
  kv('Settings', getDataPath('settings.yaml'));
  kv('Database', `${db.path} (${bytes(db.sizeBytes)})`);

  section('LLM providers');
  const providers = Object.entries(settings.providers);
  if (providers.length === 0) {
    line(color.dim('  none configured — run: athena setup'));
  } else {
    table(
      ['PROVIDER', 'STATE', 'KEYS', 'MODELS'],
      providers.map(([id, state]) => [
        id,
        state.enabled ? color.green('on') : color.dim('off'),
        String(state.keys.length),
        state.models.length === 0 ? 'all catalog' : String(state.models.length),
      ]),
    );
  }

  section('Search backends');
  const order = settings.searchProviderOrder.length > 0
    ? settings.searchProviderOrder
    : Object.keys(settings.searchProviders);
  if (order.length === 0) {
    line(color.dim('  none configured — run: athena setup'));
  } else {
    table(
      ['#', 'BACKEND', 'KEYS', 'DETAIL'],
      order.map((id, index) => {
        const state = settings.searchProviders[id];
        return [
          String(index + 1),
          id,
          String(state?.keys.length ?? 0),
          state?.zone ? `zone ${state.zone}` : state?.url ? 'custom endpoint' : 'default endpoint',
        ];
      }),
    );
  }
  line();
}

export interface KeysCommand {
  action: 'list' | 'create' | 'rename' | 'revoke' | 'plan';
  name?: string;
  plan?: KeyPlan;
  id?: string;
}

/** Admin secret for /v1/keys and /v1/analytics. Shown, never listed. */
export function runAdminKey(action: 'show' | 'rotate'): void {
  if (action === 'rotate') {
    rotateAdminKey();
    warn('The previous admin key stops working immediately. Update dashboards and scripts.');
    return;
  }
  section('Admin key');
  kv('Key', getAdminKey());
  line();
  warn('Send it as X-Admin-Key. Anyone on the local network with this key can manage API keys.');
}

/** Key administration. Mutations go through the store, not the HTTP layer. */
export async function runKeys(command: KeysCommand): Promise<void> {
  const store = new ApiPlatformStore();
  try {
    if (command.action === 'create') {
      if (!command.name) throw new Error(`A key name is required: ${KEY_NAME_RULE}. Pass --name or run without --name to be asked.`);
      const plan = command.plan ?? 'free';
      const { record, secret } = store.createApiKey(command.name, plan);
      section('Key created');
      kv('Id', record.id);
      kv('Name', record.name);
      kv('Plan', record.plan);
      kv('Secret', color.bold(secret));
      line();
      warn('The secret is shown once. Store it now; only its hash is stored.');
      return;
    }

    if (command.action === 'rename') {
      if (!command.id) throw new Error('rename needs a key id');
      if (!command.name) throw new Error(`A key name is required: ${KEY_NAME_RULE}.`);
      if (store.renameApiKey(command.id, command.name)) success(`Key ${command.id} renamed to "${command.name}".`);
      else failure(`Key ${command.id} not found.`);
      return;
    }

    if (command.action === 'revoke') {
      if (!command.id) throw new Error('revoke needs a key id');
      if (store.revokeApiKey(command.id)) success(`Key ${command.id} revoked.`);
      else failure(`Key ${command.id} not found, or already revoked.`);
      return;
    }

    if (command.action === 'plan') {
      if (!command.id) throw new Error('plan needs a key id');
      if (!command.plan) throw new Error('plan needs a target plan');
      if (store.setApiKeyPlan(command.id, command.plan)) success(`Key ${command.id} is now on the ${command.plan} plan.`);
      else failure(`Key ${command.id} not found.`);
      return;
    }

    const keys = store.listApiKeys();
    section('API keys');
    if (keys.length === 0) {
      line(color.dim('  no keys yet — create one with: athena keys create --name my-app --plan paid'));
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const usage = new Map(store.creditsByKey(today).map((row) => [row.keyId, row.creditsUsed]));
    table(
      ['ID', 'NAME', 'PLAN', 'KEYS', 'TODAY', 'LAST USED', 'STATE'],
      keys.map((record) => [
        record.id,
        record.name,
        record.plan,
        `${record.prefix}…`,
        money(usage.get(record.id) ?? 0),
        record.lastUsedAt ? record.lastUsedAt.slice(0, 16).replace('T', ' ') : 'never',
        record.revokedAt ? color.dim('revoked') : color.green('active'),
      ]),
    );
    line();
    const totalToday = [...usage.values()].reduce((sum, value) => sum + value, 0);
    info(`${keys.filter((record) => !record.revokedAt).length} active key(s), ${money(totalToday)} spent today across all keys.`);
    line();
  } finally {
    store.close();
  }
}

export interface StatsOptions {
  days?: number;
  recent?: number;
}

/** Tokens, tool calls, HTTP traffic, database and process resources. */
export async function runStats(options: StatsOptions = {}): Promise<void> {
  const days = options.days ?? 7;
  const recent = options.recent ?? 10;
  const store = new ApiPlatformStore();
  try {
    const { tokens, jobs } = readJobTotals();
    const cost = costFromUsage(tokens);
    const rollup = store.summarize(days);

    section(`Usage (last ${days} days)`);
    kv('HTTP requests', compactNumber(rollup.requests));
    kv('HTTP errors', compactNumber(rollup.errors));
    kv('Average latency', `${rollup.averageDurationMs} ms`);
    kv('Research jobs', compactNumber(jobs.jobs));
    kv('Search calls', compactNumber(jobs.searchCalls));
    kv('Fetch calls', compactNumber(jobs.fetchCalls));
    line();

    section('Tokens (all recorded jobs)');
    kv('Input', compactNumber(tokens.inputTokens));
    kv('Output', compactNumber(tokens.outputTokens));
    kv('Cache read', compactNumber(tokens.cacheReadTokens));
    kv('Cache write', compactNumber(tokens.cacheWriteTokens));
    kv('Total', color.bold(compactNumber(tokens.totalTokens)));
    kv('Model requests', compactNumber(tokens.requests));
    line();

    /* Priced from the same catalog the router reads. A model the catalog does
       not know is named rather than silently counted as free. */
    section('Cost (all recorded jobs)');
    kv('Input', money(cost.inputUsd));
    kv('Output', money(cost.outputUsd));
    kv('Cache read', money(cost.cacheReadUsd));
    kv('Total', color.bold(money(cost.totalUsd)));
    if (cost.unpricedModels.length > 0) {
      kv('Not priced', `${cost.unpricedModels.length} model(s)`);
      for (const model of cost.unpricedModels.slice(0, 5)) console.log(`    ${model}`);
    }
    line();

    if (tokens.byModel.length > 0) {
      section('Tokens by model');
      table(
        ['PROVIDER', 'MODEL', 'REQUESTS', 'TOKENS'],
        tokens.byModel.slice(0, 10).map((entry) => [entry.providerId, entry.modelId, compactNumber(entry.requests), compactNumber(entry.totalTokens)]),
      );
      line();
    }

    if (rollup.byRoute.length > 0) {
      section('Requests by route');
      table(
        ['ROUTE', 'REQUESTS', 'ERRORS'],
        rollup.byRoute.map((row) => [row.route, compactNumber(row.requests), compactNumber(row.errors)]),
      );
      line();
    }

    const sys = readSystemInfo();
    section('System');
    kv('Platform', `${sys.platform} (${sys.arch})`);
    kv('CPU', `${sys.cpuModel} × ${sys.cpuCores}`);
    kv('Load (1m)', `${sys.loadPercent}% of capacity`);
    kv('Memory', `${sys.usedMemoryPercent}% used — ${bytes(sys.totalMemoryBytes - sys.freeMemoryBytes)} / ${bytes(sys.totalMemoryBytes)}`);
    kv('Process RSS', bytes(sys.processMemoryBytes));
    kv('Uptime', `${Math.round(sys.uptimeSeconds / 60)} min`);
    line();

    const db = readDatabaseInfo();
    section('Storage');
    kv('Data dir', DATA_DIR);
    kv('Resolved from', resolvedDataDir.reason);
    kv('Database', `${db.path} (${bytes(db.sizeBytes)})`);
    kv('WAL', bytes(db.walSizeBytes));
    kv('Log file', `${getLogFilePath()} (cap ${bytes(getLogLimits().maxFileBytes)})`);
    line();

    if (rollup.byKey.length > 0) {
      section('Recent requests');
      const requests = store.recentRequests(recent);
      if (requests.length === 0) {
        line(color.dim('  none recorded'));
      } else {
        table(
          ['WHEN', 'METHOD', 'ROUTE', 'STATUS', 'MS', 'KEY'],
          requests.map((row) => [
            row.at.slice(5, 16).replace('T', ' '),
            row.method,
            row.route,
            row.status < 400 ? color.green(String(row.status)) : color.red(String(row.status)),
            String(row.durationMs),
            row.apiKeyId || color.dim('local'),
          ]),
        );
      }
      line();
    }
  } finally {
    store.close();
  }
}

export interface LogsOptions {
  lines?: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
  follow?: boolean;
}

/** Shows the tail of the log file, filtered by level, capped by its size limit. */
export function runLogs(options: LogsOptions = {}): { path: string; shown: string[] } {
  const path = getLogFilePath();
  const limits = getLogLimits();
  section('Logs');
  kv('File', path);
  kv('Size cap', `${bytes(limits.maxFileBytes)} (rotated × ${limits.keepFiles})`);
  const wanted = options.lines ?? 80;
  let shown: string[] = [];
  try {
    const text = readFileSync(path, 'utf-8');
    let all = text.split('\n').filter((entry) => entry.length > 0);
    if (options.level) {
      const needle = ` ${options.level.toUpperCase()} `;
      all = all.filter((entry) => entry.includes(needle));
    }
    shown = all.slice(-wanted);
    line();
    for (const entry of shown) line(color.dim(entry));
  } catch {
    warn(`No log file yet at ${path}. The server writes it on first start.`);
  }
  line();
  if (options.follow) {
    info('Follow mode is not available in this build; re-run to see new lines.');
  }
  return { path, shown };
}

/** Integrity check plus stale-state cleanup. Safe to run on a live system. */
export function runRepair(): void {
  const store = new ApiPlatformStore();
  try {
    section('Repair');
    const integrity = store.integrityCheck();
    if (integrity === 'ok') success('SQLite integrity: ok');
    else failure(`SQLite integrity: ${integrity}`);
    const cleared = store.clearStaleState();
    success(`Cleared ${cleared.rateLimitRows} idle rate-limit row(s).`);
    success(`Reset ${cleared.jobSlotsCleared} stale job slot row(s).`);
    const config = getConfig();
    info(`Config validated: ${Object.keys(config).length} sections loaded from config.yaml.`);
    const settings = loadSettings();
    const enabled = Object.values(settings.providers).filter((state) => state.enabled && state.keys.length > 0);
    const searches = Object.entries(settings.searchProviders).filter(([, state]) => state.keys.length > 0);
    info(`Providers ready: ${enabled.length}, search backends ready: ${searches.length}.`);
    if (integrity !== 'ok') process.exitCode = 1;
    line();
  } finally {
    store.close();
  }
}

/** Version, runtime, and where configuration lives. */
export async function runAbout(): Promise<void> {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string };
  const sys = readSystemInfo();
  let providerCount = 0;
  try {
    const snapshot = await getModelsDevSnapshot();
    providerCount = Object.keys(snapshot.providers).length;
  } catch {
    providerCount = 0;
  }
  section('About');
  kv('Athena', `v${pkg.version}`);
  kv('Node', sys.nodeVersion);
  kv('Data directory', DATA_DIR);
  kv('Resolved from', resolvedDataDir.reason);
  kv('Model catalog', `${providerCount} providers available`);
  kv('Settings', getDataPath('settings.yaml'));
  kv('Config', getDataPath('config.yaml'));
  kv('Database', getDataPath('athena.sqlite'));
  kv('Logs', getLogFilePath());
  line();
  info('Public API: POST /v1/search, /v1/contents, /v1/research');
  line();
}
