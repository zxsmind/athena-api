import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfig } from '../src/config/defaults.js';
import { getConfig, initConfig, resetConfigForTests, resolveConfig } from '../src/config/load.js';
import { validateConfig } from '../src/config/defaults.js';

const ENV_KEYS = [
  'PORT', 'HOST', 'ATHENA_JSON_BODY_LIMIT', 'ATHENA_SSE_HEARTBEAT_MS', 'ATHENA_TRUSTED_PROXIES', 'ATHENA_RETENTION_MINUTES', 'ATHENA_MAX_DATA_BYTES',
  'ATHENA_MAX_ACTIVE_JOBS', 'ATHENA_MAX_ACTIVE_BATCHES', 'ATHENA_MAX_EVENTS_PER_JOB', 'ATHENA_MAX_EVENTS_PER_BATCH',
  'ATHENA_RETENTION_MINUTES', 'ATHENA_SQLITE_BUSY_TIMEOUT_MS', 'ATHENA_SEARCH_URL', 'ATHENA_SEARCH_TIMEOUT_MS',
  'ATHENA_SEARCH_RESULT_COUNT', 'ATHENA_SEARCH_COUNTRY', 'ATHENA_SEARCH_LANGUAGE',
  'ATHENA_SEARCH_FULL_EXTRACTION_LIMIT', 'ATHENA_EXTRACTION_CONTEXT_CHARS', 'ATHENA_EXTRACTION_SNIPPET_CHARS',
  'ATHENA_MAX_TOTAL_TURNS', 'ATHENA_WRAP_UP_TOOL_CALLS', 'ATHENA_FORCE_ANSWER_TOOL_CALLS',
  'ATHENA_MAX_QUERIES_PER_SEARCH', 'ATHENA_TOOL_WAIT_HEARTBEAT_MS', 'ATHENA_HISTORY_MESSAGE_LIMIT',
  'ATHENA_SNIPPET_PREVIEW_CHARS', 'ATHENA_STALL_TIMEOUT_MS', 'ATHENA_PAUSED_TTL_MINUTES',
  'ATHENA_REPORT_INPUT_CHARS', 'ATHENA_REPORT_SNIPPET_CHARS', 'ATHENA_REPORT_CLAIM_TOKENS',
  'ATHENA_REPORT_DEFAULT_SECTION',
];

let savedEnv: Record<string, string | undefined> = {};
let tempDir = '';

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  tempDir = mkdtempSync(join(tmpdir(), 'athena-config-'));
  resetConfigForTests();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function configPath(name = 'config.json'): string {
  return join(tempDir, name);
}

describe('config defaults', () => {
  it('validates the shipped defaults', () => {
    expect(() => validateConfig(defaultConfig)).not.toThrow();
  });

  it('uses defaults when no file and no environment exist', () => {
    expect(resolveConfig(configPath('missing.json'))).toEqual(defaultConfig);
  });
});

describe('config file', () => {
  it('merges a partial file over the defaults', () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ research: { maxTotalTurns: 42 } }));
    const config = resolveConfig(path);
    expect(config.research.maxTotalTurns).toBe(42);
    expect(config.research.wrapUpToolCalls).toBe(defaultConfig.research.wrapUpToolCalls);
  });

  it('lets the file override nested mode settings', () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ modes: { instant: { maxSearchCalls: 2 } } }));
    expect(resolveConfig(path).modes.instant.maxSearchCalls).toBe(2);
    expect(resolveConfig(path).modes.instant.maxSteps).toBe(defaultConfig.modes.instant.maxSteps);
  });

  it('fails loudly on invalid JSON instead of silently using defaults', () => {
    const path = configPath();
    writeFileSync(path, '{ not json');
    expect(() => resolveConfig(path)).toThrow(/not valid JSON/);
  });

  it('rejects a value that violates the schema', () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ research: { maxTotalTurns: -5 } }));
    expect(() => resolveConfig(path)).toThrow();
  });
});

describe('environment overrides', () => {
  it('overrides file values', () => {
    const path = configPath();
    writeFileSync(path, JSON.stringify({ server: { port: 5000 } }));
    process.env.PORT = '6000';
    expect(resolveConfig(path).server.port).toBe(6000);
  });

  it('parses a proxy list', () => {
    expect(resolveConfig(configPath()).server.trustedProxies).toEqual([]);
    process.env.ATHENA_TRUSTED_PROXIES = '127.0.0.1, 10.0.0.0/8';
    expect(resolveConfig(configPath()).server.trustedProxies).toEqual(['127.0.0.1', '10.0.0.0/8']);
  });

  it('defaults the stall and paused ceilings', () => {
    const research = resolveConfig(configPath()).research;
    expect(research.stallTimeoutMs).toBe(1_200_000);
    expect(research.pausedTtlMinutes).toBe(240);
    process.env.ATHENA_PAUSED_TTL_MINUTES = '60';
    expect(resolveConfig(configPath()).research.pausedTtlMinutes).toBe(60);
  });

  it('defaults the data retention window and byte budget', () => {
    const storage = resolveConfig(configPath()).storage;
    expect(storage.retentionMinutes).toBe(1440);
    expect(storage.maxDataBytes).toBe(1_073_741_824);
    process.env.ATHENA_MAX_DATA_BYTES = '524288000';
    expect(resolveConfig(configPath()).storage.maxDataBytes).toBe(524_288_000);
  });

  it('ignores empty values so an unset variable keeps the default', () => {
    process.env.ATHENA_MAX_TOTAL_TURNS = '';
    expect(resolveConfig(configPath()).research.maxTotalTurns).toBe(defaultConfig.research.maxTotalTurns);
  });

  it('rejects a non-numeric value for a numeric field', () => {
    process.env.ATHENA_MAX_TOTAL_TURNS = 'many';
    expect(() => resolveConfig(configPath())).toThrow();
  });
});

describe('process config', () => {
  it('exposes the defaults before initialization', () => {
    expect(getConfig()).toEqual(defaultConfig);
  });

  it('replaces the active config on init', () => {
    process.env.ATHENA_MAX_QUERIES_PER_SEARCH = '5';
    initConfig(configPath());
    expect(getConfig().research.maxQueriesPerSearchCall).toBe(5);
  });
});