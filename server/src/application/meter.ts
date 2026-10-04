import { ApiPlatformStore, type KeyPlan, type PublicKeyId } from '../api-platform-store.js';
import { getConfig } from '../config/load.js';
import type { PlanConfig } from '../config/schema.js';
import { contentsCharge, researchCharge, roundCredits, searchCharge, type Charge } from '../engine/metering.js';
import type { BudgetSnapshot } from '../engine/modes.js';
import type { RateDecision } from '../rate-limit.js';import { getCachedModelTokenPrice, type ModelTokenPrice } from '../models-dev.js';

export type RefusalReason = 'rate_limit' | 'budget_exhausted';

export interface Refusal {
  reason: RefusalReason;
  retryAfterSeconds?: number;
  /** Present for budget refusals so a caller can see the balance. */
  balance?: { usedCredits: number; dailyCredits: number; overrunCredits: number };
}

/** The UTC day a balance belongs to. Resets at 00:00 UTC. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export function planFor(plan: KeyPlan): PlanConfig {
  const plans = getConfig().plans;
  const resolved = plans[plan];
  if (!resolved) throw new Error(`Unknown plan "${plan}". Configure it before issuing keys.`);
  return resolved;
}

/**
 * Owns every credit decision. Requests are admitted only while the balance is
 * above the plan's daily allowance plus its overrun allowance; the balance may
 * therefore go negative when a running job overspends, and the next request is
 * refused until the next UTC day.
 */
export class Meter {
  /**
   * @param priceOf Resolves a model's token price. Defaults to the provider
   *   catalog; injectable so billing can be tested without a live catalog.
   */
  constructor(
    private readonly store: ApiPlatformStore,
    private readonly priceOf: (providerId: string, modelId: string) => ModelTokenPrice | null =
      (providerId, modelId) => getCachedModelTokenPrice(providerId, modelId),
  ) {}

  admit(keyId: PublicKeyId | null, plan: KeyPlan | null): Refusal | null {
    if (!keyId || !plan) return null;

    /* Rate state lives in SQLite, not in this object, so every process serving
       the same database enforces the same buckets. */
    const config = planFor(plan);
    const rate: RateDecision = this.store.rateLimitTake(keyId, config.requestsPerSecond, config.requestsPerMinute, Date.now());
    if (!rate.allowed) {
      return { reason: 'rate_limit', retryAfterSeconds: rate.retryAfterSeconds };
    }

    const day = utcDay();
    const used = this.store.creditsUsedToday(keyId, day);
    /* A running job may overspend into the overrun allowance, so requests are
       admitted until the daily allowance plus that overrun is gone. */
    const ceiling = config.dailyCredits + config.overrunCredits;
    if (used > ceiling) {
      return {
        reason: 'budget_exhausted',
        balance: { usedCredits: used, dailyCredits: config.dailyCredits, overrunCredits: config.overrunCredits },
      };
    }
    return null;
  }

  /** Records a charge against the key's day. Returns the new daily total. */
  private debit(keyId: PublicKeyId | null, charge: Charge): number {
    if (!keyId || charge.total <= 0) return 0;
    return this.store.debitDailyCredits(keyId, utcDay(), roundCredits(charge.total));
  }

  chargeSearch(keyId: PublicKeyId | null): number {
    return this.debit(keyId, searchCharge(getConfig().pricing));
  }

  chargeContents(keyId: PublicKeyId | null, pages: number): number {
    return this.debit(keyId, contentsCharge(getConfig().pricing, pages));
  }

  /**
   * Bills a completed research job from its own counters. Token cost is priced
   * per model from the provider catalog; a model with no published price is
   * reported as unpriced and its tokens are not billed.
   */
  chargeResearch(keyId: PublicKeyId | null, snapshot: BudgetSnapshot, reportedTokens: boolean): number {
    const charge = researchCharge(
      getConfig().pricing,
      snapshot,
      reportedTokens,
      this.priceOf,
    );
    if (charge.unpricedModels.length > 0) {
      console.warn(`[metering] no catalog price for ${charge.unpricedModels.join(', ')}; tokens not billed`);
    }
    return this.debit(keyId, charge);
  }

  /**
   * Reserves one of the key's concurrent research job slots.
   *
   * Counted per key against the plan's `maxConcurrentJobs` in SQLite, so every
   * process serving the same database enforces the same ceiling. The reservation
   * must be released with {@link releaseJobSlot} once the job reaches a
   * terminal state, so a failed or cancelled job does not hold a slot forever.
   */
  acquireJobSlot(keyId: PublicKeyId | null, plan: KeyPlan | null): boolean {
    if (!keyId || !plan) return true;
    return this.store.jobSlotAcquire(keyId, planFor(plan).maxConcurrentJobs);
  }

  /** Returns a slot taken by {@link acquireJobSlot}. */
  releaseJobSlot(keyId: PublicKeyId | null): void {
    if (!keyId) return;
    this.store.jobSlotRelease(keyId);
  }

  /** Research jobs currently holding a slot for this key. */
  activeJobCount(keyId: PublicKeyId | null): number {
    return keyId ? this.store.jobSlotCount(keyId) : 0;
  }

  /** The plan's concurrent research job limit. */
  jobSlotLimit(plan: KeyPlan | null): number | null {
    return plan ? planFor(plan).maxConcurrentJobs : null;
  }

  balanceOf(keyId: PublicKeyId, plan: KeyPlan, day = utcDay()): { usedCredits: number; dailyCredits: number; overrunCredits: number } {
    const config = planFor(plan);
    return {
      usedCredits: this.store.creditsUsedToday(keyId, day),
      dailyCredits: config.dailyCredits,
      overrunCredits: config.overrunCredits,
    };
  }
}
