import { redis, fallbackMemoryCache, isRedisDegraded } from '../../lib/redis';
import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'StakingSentinelService' });

export interface StakingEvent {
  poolId: string;
  type: 'deposit' | 'withdraw';
  amount: number;
  timestamp?: number; // Epoch ms
  account?: string;
  txHash?: string;
}

export interface StakingPoolConfig {
  poolId: string;
  initialTvl: number;
  annualRewardEmission?: number; // Annual rewards emitted to stakers
  rewardTokenSymbol?: string;
  stakeTokenSymbol?: string;
  alertThresholdPercentage?: number; // Defaults to 15%
}

export interface StakingPoolState {
  poolId: string;
  currentTvl: number;
  annualRewardEmission: number;
  rewardTokenSymbol?: string;
  stakeTokenSymbol?: string;
  events: StakingEvent[];
  lastUpdated: number;
}

export interface StakingTvlAlert {
  poolId: string;
  alertType: 'tvl_drop_exceeded_15_percent';
  severity: 'CRITICAL';
  previousTvl: number;
  currentTvl: number;
  dropPercentage: number;
  netWithdrawalAmount: number;
  windowDurationSeconds: number;
  previousAprPercentage: number;
  updatedAprPercentage: number;
  message: string;
  timestamp: string;
}

const ROLLING_WINDOW_MS = 60 * 60 * 1000; // 1 Hour
const DEFAULT_ALERT_THRESHOLD_PERCENT = 15; // 15% drop

export class StakingSentinelService {
  private keyPrefix = 'stellar:staking:tvl:';

  private getKey(poolId: string): string {
    return `${this.keyPrefix}${poolId}`;
  }

  /**
   * Calculates estimated Annual Percentage Rate (APR) based on annual emissions and pool TVL.
   */
  public calculateApr(annualRewardEmission: number, tvl: number): number {
    if (tvl <= 0 || annualRewardEmission <= 0) {
      return 0;
    }
    const apr = (annualRewardEmission / tvl) * 100;
    return Math.round(apr * 100) / 100; // 2 decimal precision
  }

  /**
   * Registers or updates a staking pool configuration and baseline TVL state.
   */
  public async registerPool(config: StakingPoolConfig): Promise<StakingPoolState> {
    const state: StakingPoolState = {
      poolId: config.poolId,
      currentTvl: Math.max(0, config.initialTvl),
      annualRewardEmission: config.annualRewardEmission ?? 0,
      rewardTokenSymbol: config.rewardTokenSymbol,
      stakeTokenSymbol: config.stakeTokenSymbol,
      events: [],
      lastUpdated: Date.now(),
    };

    await this.persistState(state);
    logger.info(`Registered staking pool ${config.poolId} with TVL ${state.currentTvl}`);
    return state;
  }

  /**
   * Records a deposit or withdraw event, updates 1-hour rolling TVL window, and evaluates drop alerts.
   */
  public async recordEvent(event: StakingEvent): Promise<StakingTvlAlert | null> {
    const timestamp = event.timestamp ?? Date.now();
    const normalizedEvent: StakingEvent = {
      ...event,
      timestamp,
      amount: Math.abs(event.amount),
    };

    let state = await this.getPoolState(event.poolId);
    if (!state) {
      // Auto-register pool with event amount as seed if not explicitly registered
      state = {
        poolId: event.poolId,
        currentTvl: normalizedEvent.type === 'deposit' ? normalizedEvent.amount : 0,
        annualRewardEmission: 100000, // Default annual reward emission for APR estimation
        events: [],
        lastUpdated: timestamp,
      };
    }

    const previousTvl = state.currentTvl;
    const previousApr = this.calculateApr(state.annualRewardEmission, previousTvl);

    // Update current TVL
    if (normalizedEvent.type === 'deposit') {
      state.currentTvl += normalizedEvent.amount;
    } else {
      state.currentTvl = Math.max(0, state.currentTvl - normalizedEvent.amount);
    }

    state.events.push(normalizedEvent);
    state.lastUpdated = timestamp;

    // Prune events outside 1-hour rolling window
    const windowCutoff = timestamp - ROLLING_WINDOW_MS;
    state.events = state.events.filter((e) => (e.timestamp ?? 0) >= windowCutoff);

    await this.persistState(state);

    return this.evaluateShift(state, previousTvl, previousApr, timestamp);
  }

  /**
   * Evaluates the 1-hour rolling TVL shift for net withdrawals exceeding the threshold.
   */
  public async checkTvlShift(poolId: string, currentTimestamp?: number): Promise<StakingTvlAlert | null> {
    const state = await this.getPoolState(poolId);
    if (!state) return null;

    const now = currentTimestamp ?? Date.now();
    const windowCutoff = now - ROLLING_WINDOW_MS;

    // Prune stale events
    state.events = state.events.filter((e) => (e.timestamp ?? 0) >= windowCutoff);
    await this.persistState(state);

    const apr = this.calculateApr(state.annualRewardEmission, state.currentTvl);
    return this.evaluateShift(state, state.currentTvl, apr, now);
  }

  private evaluateShift(
    state: StakingPoolState,
    baselineTvl: number,
    previousApr: number,
    referenceTimestamp: number,
  ): StakingTvlAlert | null {
    const windowCutoff = referenceTimestamp - ROLLING_WINDOW_MS;
    const windowEvents = state.events.filter((e) => (e.timestamp ?? 0) >= windowCutoff);

    let totalDeposited = 0;
    let totalWithdrawn = 0;

    for (const evt of windowEvents) {
      if (evt.type === 'deposit') {
        totalDeposited += evt.amount;
      } else if (evt.type === 'withdraw') {
        totalWithdrawn += evt.amount;
      }
    }

    const netWithdrawal = totalWithdrawn - totalDeposited;
    if (netWithdrawal <= 0) {
      return null;
    }

    // Reference TVL before the net withdrawals in this window
    const startingTvlInWindow = state.currentTvl + netWithdrawal;
    if (startingTvlInWindow <= 0) {
      return null;
    }

    const dropPercentage = (netWithdrawal / startingTvlInWindow) * 100;
    const threshold = DEFAULT_ALERT_THRESHOLD_PERCENT;

    if (dropPercentage >= threshold) {
      const updatedApr = this.calculateApr(state.annualRewardEmission, state.currentTvl);

      const alert: StakingTvlAlert = {
        poolId: state.poolId,
        alertType: 'tvl_drop_exceeded_15_percent',
        severity: 'CRITICAL',
        previousTvl: Math.round(startingTvlInWindow * 100) / 100,
        currentTvl: Math.round(state.currentTvl * 100) / 100,
        dropPercentage: Math.round(dropPercentage * 100) / 100,
        netWithdrawalAmount: Math.round(netWithdrawal * 100) / 100,
        windowDurationSeconds: 3600,
        previousAprPercentage: previousApr,
        updatedAprPercentage: updatedApr,
        message:
          `🚨 [Critical Alert] Staking pool ${state.poolId} TVL dropped by ${dropPercentage.toFixed(2)}% ` +
          `(Net withdrawals: ${netWithdrawal.toFixed(2)}) within 1 hour. TVL: ${state.currentTvl}. Updated APR: ${updatedApr.toFixed(2)}%`,
        timestamp: new Date(referenceTimestamp).toISOString(),
      };

      logger.warn(alert.message);
      return alert;
    }

    return null;
  }

  public async getPoolState(poolId: string): Promise<StakingPoolState | null> {
    const key = this.getKey(poolId);
    try {
      if (!isRedisDegraded()) {
        const raw = await redis.get(key);
        if (raw) {
          return JSON.parse(raw);
        }
      }
    } catch {
      // Degraded or Redis failed, fall back
    }

    const fallbackRaw = fallbackMemoryCache.get(key);
    if (fallbackRaw) {
      try {
        return JSON.parse(fallbackRaw);
      } catch {
        return null;
      }
    }

    return null;
  }

  private async persistState(state: StakingPoolState): Promise<void> {
    const key = this.getKey(state.poolId);
    const json = JSON.stringify(state);

    // Save to fallback memory cache unconditionally
    fallbackMemoryCache.set(key, json, 7200);

    try {
      if (!isRedisDegraded()) {
        await redis.set(key, json, 'EX', 7200);
      }
    } catch {
      // Redis degradation handled gracefully
    }
  }

  public async resetPoolState(poolId: string): Promise<void> {
    const key = this.getKey(poolId);
    fallbackMemoryCache.del(key);
    try {
      if (!isRedisDegraded()) {
        await redis.del(key);
      }
    } catch {
      // Ignore
    }
  }
}

export const stakingSentinelService = new StakingSentinelService();
