import { existsSync, statSync } from 'node:fs';
import { arch, cpus, freemem, loadavg, totalmem, type as osType, release, uptime } from 'node:os';
import { getDatabase, getDataPath } from '../storage.js';
import { getCachedModelTokenPrice, type ModelTokenPrice } from '../models-dev.js';
import type { TokenUsageByModel } from '../engine/modes.js';

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  requests: number;
  byModel: Array<{
    providerId: string;
    modelId: string;
    totalTokens: number;
    requests: number;
    /* The per-stream split, kept so cost can be priced without re-reading the
       ledger. Without it a cache read would be charged at the input rate. */
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }>;
}

/**
 * Spend, priced from the same catalog the router reads.
 *
 * A model the catalog has never heard of is reported separately rather than
 * priced at zero, because a zero would read as free and quietly understate the
 * bill. `unpriced` is the number of models that could not be costed.
 */
export interface CostTotals {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  totalUsd: number;
  unpricedModels: string[];
}

export interface JobTotals {
  jobs: number;
  byStatus: Record<string, number>;
  searchCalls: number;
  fetchCalls: number;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  cpuModel: string;
  cpuCores: number;
  loadAverage: [number, number, number];  loadPercent: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  usedMemoryPercent: number;
  processMemoryBytes: number;
  uptimeSeconds: number;
}

export interface DatabaseInfo {
  path: string;
  sizeBytes: number;
  walSizeBytes: number;
  exists: boolean;
}

const EMPTY_TOKENS: TokenTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  requests: 0,
  byModel: [],
};

function addUsage(totals: TokenTotals, usage: TokenUsageByModel): void {
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cacheReadTokens += usage.cacheReadTokens;
  totals.cacheWriteTokens += usage.cacheWriteTokens;
  totals.requests += usage.requests;
  totals.totalTokens += usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const key = `${usage.providerId}/${usage.modelId}`;
  const existing = totals.byModel.find((entry) => `${entry.providerId}/${entry.modelId}` === key);
  const modelTotal = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  if (existing) {
    existing.totalTokens += modelTotal;
    existing.requests += usage.requests;
    existing.inputTokens += usage.inputTokens;
    existing.outputTokens += usage.outputTokens;
    existing.cacheReadTokens += usage.cacheReadTokens;
    existing.cacheWriteTokens += usage.cacheWriteTokens;
  } else {
    totals.byModel.push({
      providerId: usage.providerId,
      modelId: usage.modelId,
      totalTokens: modelTotal,
      requests: usage.requests,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
  }
}

/**
 * Prices a model's usage with the catalog the router already uses.
 *
 * Cache reads are priced separately because they cost a fraction of a fresh
 * input token, and folding them into the input price overstates the bill by
 * roughly the cache discount. A model the catalog does not know is named rather
 * than costed at zero.
 */
export function costFromUsage(totals: TokenTotals): CostTotals {
  const cost: CostTotals = { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, totalUsd: 0, unpricedModels: [] };
  for (const entry of totals.byModel) {
    const price = getCachedModelTokenPrice(entry.providerId, entry.modelId);
    if (!price) {
      cost.unpricedModels.push(`${entry.providerId}/${entry.modelId}`);
      continue;
    }
    /* byModel only keeps the token total, so the split has to come from the
       aggregate. The three are charged in proportion to the model they belong
       to, which is exact here because one ledger entry is one provider/model. */
    const perModel = priceTokensFor(entry, price);
    cost.inputUsd += perModel.inputUsd;
    cost.outputUsd += perModel.outputUsd;
    cost.cacheReadUsd += perModel.cacheReadUsd;
  }
  cost.totalUsd = cost.inputUsd + cost.outputUsd + cost.cacheReadUsd;
  return cost;
}

/** Recomputes one model's split. Kept beside `addUsage` so the two agree. */
function priceTokensFor(entry: TokenTotals['byModel'][number], price: ModelTokenPrice): { inputUsd: number; outputUsd: number; cacheReadUsd: number } {
  return {
    inputUsd: (entry.inputTokens / 1e6) * price.input,
    outputUsd: (entry.outputTokens / 1e6) * price.output,
    cacheReadUsd: (entry.cacheReadTokens / 1e6) * price.cacheRead,
  };
}

/**
 * Token and tool totals are read from persisted job snapshots, because the
 * token ledger lives there. A database with no job table yet reports zeroes,
 * so the CLI works on a fresh install.
 */
export function readJobTotals(): { tokens: TokenTotals; jobs: JobTotals } {
  const tokens: TokenTotals = { ...EMPTY_TOKENS, byModel: [] };
  const jobs: JobTotals = { jobs: 0, byStatus: {}, searchCalls: 0, fetchCalls: 0 };
  const db = getDatabase();
  const hasJobs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'research_jobs'").get() !== undefined;
  if (!hasJobs) return { tokens, jobs };
  const rows = db.prepare('SELECT status, data FROM research_jobs').all() as Array<{ status: string; data: string }>;
  for (const row of rows) {
    jobs.jobs += 1;
    jobs.byStatus[row.status] = (jobs.byStatus[row.status] ?? 0) + 1;
    let snapshot: Record<string, unknown>;
    try {
      snapshot = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const runtime = (snapshot.runtime ?? {}) as Record<string, unknown>;
    const budget = (runtime.budget ?? {}) as Record<string, unknown>;
    const searchCalls = Number(budget.usedSearchCalls ?? 0);
    const fetchCalls = Number(budget.usedFetchCalls ?? 0);
    jobs.searchCalls += Number.isFinite(searchCalls) ? searchCalls : 0;
    jobs.fetchCalls += Number.isFinite(fetchCalls) ? fetchCalls : 0;
    const ledger = (budget.tokenLedger ?? {}) as Record<string, TokenUsageByModel>;
    for (const usage of Object.values(ledger)) {
      if (usage && typeof usage === 'object') addUsage(tokens, usage);
    }
  }
  tokens.byModel.sort((a, b) => b.totalTokens - a.totalTokens);
  return { tokens, jobs };
}

export function readSystemInfo(): SystemInfo {
  const cores = cpus();
  const load = loadavg();
  const [oneMinute, fiveMinutes, fifteenMinutes] = load;
  const total = totalmem();
  const free = freemem();
  const coresSafe = cores.length || 1;
  return {
    platform: `${osType()} ${release()}`,
    arch: arch(),
    nodeVersion: process.version,
    cpuModel: cores[0]?.model.trim() ?? 'unknown',
    cpuCores: cores.length,
    loadAverage: [oneMinute, fiveMinutes, fifteenMinutes],
    /* One-minute load per core, as a percentage. Meaningful on Linux; on other
       platforms it is a rough indicator, which the CLI labels accordingly. */
    loadPercent: Math.round((load[0] / coresSafe) * 100),
    totalMemoryBytes: total,
    freeMemoryBytes: free,
    usedMemoryPercent: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
    processMemoryBytes: process.memoryUsage().rss,
    uptimeSeconds: Math.round(uptime()),
  };
}

export function readDatabaseInfo(): DatabaseInfo {
  const path = getDataPath('athena.sqlite');
  const exists = existsSync(path);
  const size = (file: string): number => {
    try {
      return existsSync(file) ? statSync(file).size : 0;
    } catch {
      return 0;
    }
  };
  return {
    path,
    exists,
    sizeBytes: exists ? size(path) : 0,
    walSizeBytes: size(`${path}-wal`),
  };
}

/** Format helpers shared by `stats` and `status`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`;
}

export function formatAge(iso: string | null): string {
  if (!iso) return 'never';
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return 'unknown';
  /* Ages read better without a zero remainder: `2m ago`, not `2m 0s ago`. */
  return `${formatDuration(Math.round(elapsed / 1000)).replace(/ 0s$/, '')} ago`;
}
