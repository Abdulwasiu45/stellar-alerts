import { getRedisClient } from '../redis';
import { createLogger } from '../logger';

const log = createLogger({ module: 'FairShareQueueScheduler' });

/**
 * Subscriber tier configuration
 */
export interface SubscriberTier {
  name: string;
  maxBurstRate: number; // jobs per second
  maxSustainedRate: number; // jobs per second (average over longer window)
  refillRate: number; // tokens per millisecond
}

/**
 * Predefined subscriber tiers
 */
export const SUBSCRIBER_TIERS: Record<string, SubscriberTier> = {
  free: {
    name: 'free',
    maxBurstRate: 10,
    maxSustainedRate: 2,
    refillRate: 0.002, // 2 tokens/sec
  },
  professional: {
    name: 'professional',
    maxBurstRate: 100,
    maxSustainedRate: 20,
    refillRate: 0.02, // 20 tokens/sec
  },
  enterprise: {
    name: 'enterprise',
    maxBurstRate: 1000,
    maxSustainedRate: 100,
    refillRate: 0.1, // 100 tokens/sec
  },
};

/**
 * Result of a fair share scheduling decision
 */
export interface SchedulingDecision {
  canProcess: boolean;
  waitTimeMs: number;
  tokensAvailable: number;
  tier: SubscriberTier;
  queueLength: number;
}

/**
 * Tenant scheduling state
 */
interface TenantState {
  tokens: number;
  lastRefillTime: number;
  queueLength: number;
}

/**
 * FairShareQueueScheduler implements hierarchical deficit round-robin token
 * buckets per subscriber tenant. Prevents noisy tenants with high-volume alerts
 * from monopolizing dispatcher workers.
 *
 * Architecture:
 * 1. Each tenant has a separate virtual token bucket
 * 2. Token buckets refill at tier-specific rates
 * 3. Jobs are scheduled in round-robin order across tenants
 * 4. Scheduling priority based on token availability and queue age
 * 5. Low-volume tenants get priority when backlog is high
 */
export class FairShareQueueScheduler {
  private redis = getRedisClient();
  private tenantStates = new Map<string, TenantState>();
  private tenantOrder: string[] = [];
  private lastScheduleIndex = 0;
  private stats = {
    jobsProcessed: 0,
    jobsDeferred: 0,
    tenantHighWaterMarks: new Map<string, number>(),
  };

  /**
   * Gets the tier for a subscriber
   */
  getTierForSubscriber(subscriberId: string, tierName: string = 'standard'): SubscriberTier {
    const tier = SUBSCRIBER_TIERS[tierName];
    if (!tier) {
      log.warn({ subscriberId, tierName }, 'Unknown subscriber tier, defaulting to professional');
      return SUBSCRIBER_TIERS.professional;
    }
    return tier;
  }

  /**
   * Gets or creates tenant state
   */
  private getOrCreateTenantState(tenantId: string, tier: SubscriberTier): TenantState {
    let state = this.tenantStates.get(tenantId);

    if (!state) {
      state = {
        tokens: tier.maxBurstRate, // Start with burst capacity
        lastRefillTime: Date.now(),
        queueLength: 0,
      };
      this.tenantStates.set(tenantId, state);

      // Add to round-robin order
      if (!this.tenantOrder.includes(tenantId)) {
        this.tenantOrder.push(tenantId);
      }
    }

    return state;
  }

  /**
   * Refills tokens based on elapsed time since last refill
   */
  private refillTokens(state: TenantState, tier: SubscriberTier): void {
    const now = Date.now();
    const elapsedMs = now - state.lastRefillTime;

    if (elapsedMs > 0) {
      const tokensToAdd = elapsedMs * tier.refillRate;
      state.tokens = Math.min(tier.maxBurstRate, state.tokens + tokensToAdd);
      state.lastRefillTime = now;
    }
  }

  /**
   * Checks if a job can be scheduled for a tenant
   */
  async canScheduleJob(
    tenantId: string,
    tierName: string = 'professional',
    queueLength: number = 0,
  ): Promise<SchedulingDecision> {
    const tier = this.getTierForSubscriber(tenantId, tierName);
    const state = this.getOrCreateTenantState(tenantId, tier);

    // Update queue length
    state.queueLength = queueLength;

    // Refill tokens
    this.refillTokens(state, tier);

    // Check if tenant has tokens
    if (state.tokens >= 1) {
      state.tokens -= 1;
      this.stats.jobsProcessed++;

      // Track high water mark for monitoring
      const currentHWM = this.stats.tenantHighWaterMarks.get(tenantId) || 0;
      if (queueLength > currentHWM) {
        this.stats.tenantHighWaterMarks.set(tenantId, queueLength);
      }

      return {
        canProcess: true,
        waitTimeMs: 0,
        tokensAvailable: Math.floor(state.tokens),
        tier,
        queueLength,
      };
    }

    // Calculate wait time until next token is available
    const tokensNeeded = 1 - state.tokens;
    const waitTimeMs = Math.ceil((tokensNeeded / tier.refillRate) * 1000);

    this.stats.jobsDeferred++;

    return {
      canProcess: false,
      waitTimeMs,
      tokensAvailable: 0,
      tier,
      queueLength,
    };
  }

  /**
   * Selects the next tenant to process in round-robin order
   * Prioritizes tenants with available tokens and shorter queues
   */
  async selectNextTenant(
    tenantQueues: Map<string, { tierName: string; queueLength: number }>,
  ): Promise<string | null> {
    if (tenantQueues.size === 0) {
      return null;
    }

    // Build tenant scheduling scores
    const scores: Array<{ tenantId: string; score: number; canProcess: boolean }> = [];

    for (const [tenantId, queueInfo] of tenantQueues.entries()) {
      const decision = await this.canScheduleJob(
        tenantId,
        queueInfo.tierName,
        queueInfo.queueLength,
      );

      if (decision.canProcess) {
        // Prioritize low-backlog, high-tier tenants
        const tierPriority =
          SUBSCRIBER_TIERS.enterprise === decision.tier
            ? 3
            : SUBSCRIBER_TIERS.professional === decision.tier
              ? 2
              : 1;

        // Lower queue length = higher priority
        const queuePriority = Math.max(0, 100 - queueInfo.queueLength);

        const score = tierPriority * 10 + queuePriority;

        scores.push({
          tenantId,
          score,
          canProcess: true,
        });
      } else {
        scores.push({
          tenantId,
          score: 0,
          canProcess: false,
        });
      }
    }

    // Find best candidate (processable with highest score)
    const processable = scores.filter((s) => s.canProcess).sort((a, b) => b.score - a.score);

    if (processable.length > 0) {
      return processable[0].tenantId;
    }

    // No processable tenants, but return the least loaded one for logging
    return scores.length > 0 ? scores[0].tenantId : null;
  }

  /**
   * Gets the scheduling delay for a tenant when deferred
   */
  async getSchedulingDelay(
    tenantId: string,
    tierName: string = 'professional',
  ): Promise<number> {
    const tier = this.getTierForSubscriber(tenantId, tierName);
    const state = this.getOrCreateTenantState(tenantId, tier);

    this.refillTokens(state, tier);

    if (state.tokens >= 1) {
      return 0;
    }

    const tokensNeeded = 1 - state.tokens;
    return Math.ceil((tokensNeeded / tier.refillRate) * 1000);
  }

  /**
   * Records job completion and updates tenant state
   */
  async recordJobCompletion(tenantId: string, processingTimeMs: number): Promise<void> {
    const state = this.tenantStates.get(tenantId);
    if (state && state.queueLength > 0) {
      state.queueLength--;
    }
  }

  /**
   * Gets fair scheduler statistics
   */
  getStats(): {
    jobsProcessed: number;
    jobsDeferred: number;
    activeTenants: number;
    tenantHighWaterMarks: Record<string, number>;
    fairnessRatio: number;
  } {
    const marks: Record<string, number> = {};
    for (const [tenantId, watermark] of this.stats.tenantHighWaterMarks.entries()) {
      marks[tenantId] = watermark;
    }

    // Fairness ratio: closer to 1.0 means more fair distribution
    // Calculated as min(hwm) / max(hwm) across tenants
    const watermarks = Array.from(this.stats.tenantHighWaterMarks.values());
    let fairnessRatio = 1.0;
    if (watermarks.length > 1) {
      const minHWM = Math.min(...watermarks);
      const maxHWM = Math.max(...watermarks);
      fairnessRatio = maxHWM > 0 ? minHWM / maxHWM : 1.0;
    }

    return {
      jobsProcessed: this.stats.jobsProcessed,
      jobsDeferred: this.stats.jobsDeferred,
      activeTenants: this.tenantStates.size,
      tenantHighWaterMarks: marks,
      fairnessRatio,
    };
  }

  /**
   * Resets statistics
   */
  resetStats(): void {
    this.stats = {
      jobsProcessed: 0,
      jobsDeferred: 0,
      tenantHighWaterMarks: new Map<string, number>(),
    };
  }

  /**
   * Clears all tenant state (for testing or maintenance)
   */
  clearTenantStates(): void {
    this.tenantStates.clear();
    this.tenantOrder = [];
    this.lastScheduleIndex = 0;
  }

  /**
   * Gets current tenant state for monitoring
   */
  getTenantState(tenantId: string): TenantState | undefined {
    return this.tenantStates.get(tenantId);
  }

  /**
   * Gets all active tenants
   */
  getActiveTenants(): string[] {
    return Array.from(this.tenantStates.keys());
  }
}

// Export singleton instance
export const fairShareQueueScheduler = new FairShareQueueScheduler();
