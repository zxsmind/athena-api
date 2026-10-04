import type { PricingConfig } from '../config/schema.js';
import type { BudgetSnapshot, TokenUsageByModel } from './modes.js';
import type { ModelTokenPrice } from '../models-dev.js';

/**
 * Credits are US dollars. Every rate is credits per unit of work. Nothing here
 * estimates: a charge is only produced from counters the system actually
 * observed, and an unpriced component is reported instead of guessed.
 */
export type ChargeReason = 'search_request' | 'contents_page' | 'research_search_call' | 'research_fetch_call' | 'research_cpu_seconds' | 'research_token';

export interface ChargeLine {
  reason: ChargeReason;
  units: number;
  credits: number;
  /** False when the rate is unknown, so the line must not be billed. */
  priced: boolean;
}

export interface Charge {
  lines: ChargeLine[];
  total: number;
  /** Components that could not be priced and are therefore excluded. */
  unpriced: ChargeReason[];
  /** Models present in the run whose price the catalog does not publish. */
  unpricedModels: string[];
}

export function searchCharge(pricing: PricingConfig): Charge {
  const priced = pricing.searchRequest >= 0;
  return {
    lines: [{ reason: 'search_request', units: 1, credits: priced ? pricing.searchRequest : 0, priced }],
    total: priced ? pricing.searchRequest : 0,
    unpriced: priced ? [] : ['search_request'],
    unpricedModels: [],
  };
}

export function contentsCharge(pricing: PricingConfig, pages: number): Charge {
  const units = Math.max(0, pages);
  const priced = pricing.contentsPage >= 0;
  return {
    lines: [{ reason: 'contents_page', units, credits: priced ? units * pricing.contentsPage : 0, priced }],
    total: priced ? units * pricing.contentsPage : 0,
    unpriced: priced ? [] : ['contents_page'],
    unpricedModels: [],
  };
}

/**
 * Research is billed from the job's own counters: searches and page reads it
 * performed, plus the tokens it consumed priced per model.
 *
 * Token prices come from the provider catalog and are US dollars per one
 * million tokens. A model with no published price is reported as unpriced and
 * its tokens are not billed, rather than being charged at a guessed rate.
 */
export function researchCharge(
  pricing: PricingConfig,
  snapshot: Pick<BudgetSnapshot, 'used_search_calls' | 'used_fetch_calls' | 'used_cpu_seconds' | 'used_tokens' | 'token_ledger'>,
  reportedTokens: boolean,
  priceOf?: (providerId: string, modelId: string) => ModelTokenPrice | null,
): Charge {
  /* Rows written before CPU metering existed carry no field; they bill zero
     seconds rather than failing the charge. */
  const cpuSeconds = snapshot.used_cpu_seconds ?? 0;
  const cpuPriced = pricing.researchCpuSecond >= 0;
  const lines: ChargeLine[] = [
    {
      reason: 'research_search_call',
      units: snapshot.used_search_calls,
      credits: pricing.researchSearchCall * snapshot.used_search_calls,
      priced: true,
    },
    {
      reason: 'research_fetch_call',
      units: snapshot.used_fetch_calls,
      credits: pricing.researchFetchCall * snapshot.used_fetch_calls,
      priced: true,
    },
    {
      reason: 'research_cpu_seconds',
      units: cpuSeconds,
      credits: cpuPriced ? pricing.researchCpuSecond * cpuSeconds : 0,
      priced: cpuPriced,
    },
  ];

  const ledger = snapshot.token_ledger ?? {};
  const unpricedModels: string[] = [];
  let tokenCredits = 0;
  let tokenUnits = 0;

  if (reportedTokens) {
    for (const [key, usage] of Object.entries(ledger)) {
      tokenUnits += usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      const price = priceOf?.(usage.providerId, usage.modelId) ?? null;
      if (!price) {
        unpricedModels.push(key);
        continue;
      }
      tokenCredits += tokenCreditsFor(usage, price);
    }
  }

  lines.push({
    reason: 'research_token',
    units: tokenUnits,
    credits: tokenCredits,
    priced: unpricedModels.length === 0,
  });

  const unpriced = lines.filter((line) => !line.priced).map((line) => line.reason);
  return {
    lines,
    total: lines.reduce((sum, line) => sum + (line.priced ? line.credits : 0), 0),
    unpriced,
    unpricedModels,
  };
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/** Credits for one model's usage. Prices are per million tokens. */
export function tokenCreditsFor(usage: TokenUsageByModel, price: ModelTokenPrice): number {
  return (
    usage.inputTokens * price.input
    + usage.outputTokens * price.output
    + usage.cacheReadTokens * price.cacheRead
    + usage.cacheWriteTokens * price.cacheWrite
  ) / TOKENS_PER_PRICE_UNIT;
}

export function chargeTotal(charge: Charge): number {
  return charge.total;
}

/** Rounds to micro-credits so SQLite REAL accumulation cannot drift visibly. */
export function roundCredits(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
