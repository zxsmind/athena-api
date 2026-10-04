import 'dotenv/config';
import { defaultConfig, validateConfig } from './defaults.js';
import type { AppConfig } from './schema.js';
import { readStructuredFile } from '../config-file.js';

type PartialDeep<T> = { [K in keyof T]?: T[K] extends object ? PartialDeep<T[K]> : T[K] };

type EnvKind = 'string' | 'number' | 'boolean' | 'nullableNumber' | 'stringList';

export type { PartialDeep };

let active: AppConfig = defaultConfig;

/** Scalar environment overrides, grouped by their path in the config. */
const ENV_MAP: Array<{ path: string; key: string; kind: EnvKind }> = [
  { path: 'server.host', key: 'HOST', kind: 'string' },
  { path: 'server.port', key: 'PORT', kind: 'number' },
  { path: 'server.jsonBodyLimit', key: 'ATHENA_JSON_BODY_LIMIT', kind: 'string' },
  { path: 'server.sseHeartbeatMs', key: 'ATHENA_SSE_HEARTBEAT_MS', kind: 'number' },
  { path: 'server.trustedProxies', key: 'ATHENA_TRUSTED_PROXIES', kind: 'stringList' },
  { path: 'storage.maxActiveJobs', key: 'ATHENA_MAX_ACTIVE_JOBS', kind: 'number' },
  { path: 'storage.maxActiveBatches', key: 'ATHENA_MAX_ACTIVE_BATCHES', kind: 'number' },
  { path: 'storage.maxEventsPerJob', key: 'ATHENA_MAX_EVENTS_PER_JOB', kind: 'number' },
  { path: 'storage.maxEventsPerBatch', key: 'ATHENA_MAX_EVENTS_PER_BATCH', kind: 'number' },
  { path: 'storage.retentionMinutes', key: 'ATHENA_RETENTION_MINUTES', kind: 'number' },
  { path: 'storage.sqliteBusyTimeoutMs', key: 'ATHENA_SQLITE_BUSY_TIMEOUT_MS', kind: 'number' },
  { path: 'logging.maxFileBytes', key: 'ATHENA_LOG_MAX_BYTES', kind: 'number' },
  { path: 'logging.echoToStdout', key: 'ATHENA_LOG_ECHO', kind: 'boolean' },
  { path: 'catalog.refreshIntervalHours', key: 'ATHENA_CATALOG_REFRESH_HOURS', kind: 'number' },
  { path: 'search.baseUrl', key: 'ATHENA_SEARCH_URL', kind: 'string' },
  { path: 'search.requestTimeoutMs', key: 'ATHENA_SEARCH_TIMEOUT_MS', kind: 'number' },
  { path: 'search.defaultResultCount', key: 'ATHENA_SEARCH_RESULT_COUNT', kind: 'number' },
  { path: 'search.defaultCountry', key: 'ATHENA_SEARCH_COUNTRY', kind: 'string' },
  { path: 'search.defaultLanguage', key: 'ATHENA_SEARCH_LANGUAGE', kind: 'string' },
  { path: 'search.fullExtractionLimit', key: 'ATHENA_SEARCH_FULL_EXTRACTION_LIMIT', kind: 'number' },
  { path: 'search.extractionContextChars', key: 'ATHENA_EXTRACTION_CONTEXT_CHARS', kind: 'number' },
  { path: 'search.extractionSnippetChars', key: 'ATHENA_EXTRACTION_SNIPPET_CHARS', kind: 'number' },
  { path: 'research.maxTotalTurns', key: 'ATHENA_MAX_TOTAL_TURNS', kind: 'number' },
  { path: 'research.wrapUpToolCalls', key: 'ATHENA_WRAP_UP_TOOL_CALLS', kind: 'number' },
  { path: 'research.forceAnswerToolCalls', key: 'ATHENA_FORCE_ANSWER_TOOL_CALLS', kind: 'number' },
  { path: 'research.maxQueriesPerSearchCall', key: 'ATHENA_MAX_QUERIES_PER_SEARCH', kind: 'number' },
  { path: 'research.toolWaitHeartbeatMs', key: 'ATHENA_TOOL_WAIT_HEARTBEAT_MS', kind: 'number' },
  { path: 'research.historyMessageLimit', key: 'ATHENA_HISTORY_MESSAGE_LIMIT', kind: 'number' },
  { path: 'research.snippetPreviewChars', key: 'ATHENA_SNIPPET_PREVIEW_CHARS', kind: 'number' },
  { path: 'compaction.enabled', key: 'ATHENA_COMPACTION_ENABLED', kind: 'boolean' },
  { path: 'compaction.triggerTokens', key: 'ATHENA_COMPACTION_TRIGGER_TOKENS', kind: 'number' },
  { path: 'compaction.keepRecentRounds', key: 'ATHENA_COMPACTION_KEEP_ROUNDS', kind: 'number' },
  { path: 'compaction.stateMaxChars', key: 'ATHENA_COMPACTION_STATE_CHARS', kind: 'number' },
  { path: 'compaction.summaryEnabled', key: 'ATHENA_COMPACTION_SUMMARY', kind: 'boolean' },
  { path: 'report.extractionInputChars', key: 'ATHENA_REPORT_INPUT_CHARS', kind: 'number' },
  { path: 'report.evidenceSnippetChars', key: 'ATHENA_REPORT_SNIPPET_CHARS', kind: 'number' },
  { path: 'report.claimPassMaxTokens', key: 'ATHENA_REPORT_CLAIM_TOKENS', kind: 'number' },
  { path: 'report.defaultSectionHeading', key: 'ATHENA_REPORT_DEFAULT_SECTION', kind: 'string' },
  { path: 'pricing.searchRequest', key: 'ATHENA_PRICE_SEARCH', kind: 'number' },
  { path: 'pricing.contentsPage', key: 'ATHENA_PRICE_CONTENTS_PAGE', kind: 'number' },
  { path: 'pricing.researchSearchCall', key: 'ATHENA_PRICE_RESEARCH_SEARCH', kind: 'number' },
  { path: 'pricing.researchFetchCall', key: 'ATHENA_PRICE_RESEARCH_FETCH', kind: 'number' },
  { path: 'plans.free.dailyCredits', key: 'ATHENA_PLAN_FREE_CREDITS', kind: 'number' },
  { path: 'plans.free.maxConcurrentJobs', key: 'ATHENA_PLAN_FREE_CONCURRENCY', kind: 'number' },
  { path: 'plans.paid.dailyCredits', key: 'ATHENA_PLAN_PAID_CREDITS', kind: 'number' },
  { path: 'plans.paid.maxConcurrentJobs', key: 'ATHENA_PLAN_PAID_CONCURRENCY', kind: 'number' },
  { path: 'plans.enterprise.dailyCredits', key: 'ATHENA_PLAN_ENTERPRISE_CREDITS', kind: 'number' },
  { path: 'plans.enterprise.maxConcurrentJobs', key: 'ATHENA_PLAN_ENTERPRISE_CONCURRENCY', kind: 'number' },
  { path: 'plans.free.overrunCredits', key: 'ATHENA_PLAN_FREE_OVERRUN', kind: 'number' },
  { path: 'plans.paid.overrunCredits', key: 'ATHENA_PLAN_PAID_OVERRUN', kind: 'number' },
  { path: 'plans.enterprise.overrunCredits', key: 'ATHENA_PLAN_ENTERPRISE_OVERRUN', kind: 'number' },
  { path: 'plans.free.requestsPerSecond', key: 'ATHENA_PLAN_FREE_RPS', kind: 'number' },
  { path: 'plans.free.requestsPerMinute', key: 'ATHENA_PLAN_FREE_RPM', kind: 'number' },
  { path: 'plans.paid.requestsPerSecond', key: 'ATHENA_PLAN_PAID_RPS', kind: 'number' },
  { path: 'plans.paid.requestsPerMinute', key: 'ATHENA_PLAN_PAID_RPM', kind: 'number' },
  { path: 'plans.enterprise.requestsPerSecond', key: 'ATHENA_PLAN_ENTERPRISE_RPS', kind: 'nullableNumber' },
  { path: 'plans.enterprise.requestsPerMinute', key: 'ATHENA_PLAN_ENTERPRISE_RPM', kind: 'nullableNumber' },
];

/** A null rate means the plan is unlimited; parseEnvValue leaves it unset. */
function parseNullableNumber(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop();
  if (!last) return;
  let node = target;
  for (const key of keys) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[last] = value;
}

function parseEnvValue(raw: string, kind: EnvKind): unknown {
  if (kind === 'number') return Number(raw);
  if (kind === 'nullableNumber') return parseNullableNumber(raw);
  if (kind === 'boolean') return raw === 'true' || raw === '1';
  /* Comma/space separated list; empties dropped so an empty var keeps the default. */
  if (kind === 'stringList') return raw.split(/[\s,;]+/).map((part) => part.trim()).filter((part) => part.length > 0);
  return raw;
}

function readConfigFile(path: string): PartialDeep<AppConfig> {
  return readStructuredFile(path) as PartialDeep<AppConfig>;
}

function envOverrides(): PartialDeep<AppConfig> {
  const out: Record<string, unknown> = {};
  for (const entry of ENV_MAP) {
    const raw = process.env[entry.key];
    if (raw === undefined || raw === '') continue;
    setPath(out, entry.path, parseEnvValue(raw, entry.kind));
  }
  return out as PartialDeep<AppConfig>;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch as T;
  if (typeof patch !== 'object') return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

/** Resolves defaults, then the config file, then environment overrides. */
export function resolveConfig(configPath: string): AppConfig {
  const merged = deepMerge(deepMerge(defaultConfig, readConfigFile(configPath)), envOverrides());
  return validateConfig(merged);
}

export function getConfig(): AppConfig {
  return active;
}

export function setConfig(config: AppConfig): void {
  active = validateConfig(config);
}

/** Loads configuration once at startup; the result governs the whole process. */
export function initConfig(configPath: string): AppConfig {
  active = resolveConfig(configPath);
  return active;
}

export function resetConfigForTests(): void {
  active = defaultConfig;
}