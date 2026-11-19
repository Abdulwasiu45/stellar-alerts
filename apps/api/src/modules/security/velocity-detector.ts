import { redis } from '../../lib/redis';
import { createLogger } from '../../lib/logger';
import { enqueuePaymentAlert, type AlertJobData } from '../../lib/queue';

const log = createLogger({ module: 'VelocityAnomalyDetector' });

export interface BaselineMetrics {
  meanVolume: number;
  stdDevVolume: number;
  meanFrequency: number;
  stdDevFrequency: number;
  sampleCount: number;
}

export interface AnomalyCheckResult {
  isAnomaly: boolean;
  zScore: number;
  current10mVolume: number;
  current10mFrequency: number;
  baseline: BaselineMetrics;
  threshold: number;
  reason?: string;
}

export interface OutgoingTransferParams {
  accountId: string;
  amount: number;
  txHash: string;
  asset?: string;
  timestamp?: number;
  walletId?: string;
  userId?: string;
}

export interface SecurityAlertPayload {
  accountId: string;
  walletId?: string;
  userId?: string;
  txHash: string;
  amount: number;
  asset: string;
  zScore: number;
  current10mVolume: number;
  baseline: BaselineMetrics;
  timestamp: string;
}

export class VelocityAnomalyDetector {
  private readonly redisClient: typeof redis;
  private readonly zScoreThreshold: number;
  private readonly baselineWindowMs: number; // 7 days in ms
  private readonly currentWindowMs: number; // 10 minutes in ms

  constructor(
    customRedis?: typeof redis,
    options?: {
      zScoreThreshold?: number;
      baselineDays?: number;
      currentWindowMinutes?: number;
    }
  ) {
    this.redisClient = customRedis || redis;
    this.zScoreThreshold = options?.zScoreThreshold ?? 3.0;
    this.baselineWindowMs = (options?.baselineDays ?? 7) * 24 * 60 * 60 * 1000;
    this.currentWindowMs = (options?.currentWindowMinutes ?? 10) * 60 * 1000;
  }

  /**
   * Helper to compute Z-score: (value - mean) / stdDev
   */
  public calculateZScore(value: number, mean: number, stdDev: number): number {
    if (stdDev <= 0) {
      if (value > mean) {
        // When there is no variance, any positive divergence above mean is anomalous
        return mean > 0 ? (value - mean) / (mean * 0.1) : (value > 0 ? 10.0 : 0.0);
      }
      return 0.0;
    }
    return (value - mean) / stdDev;
  }

  /**
   * Calculate mean and sample standard deviation of an array of numbers.
   */
  public calculateStats(values: number[]): { mean: number; stdDev: number } {
    if (!values || values.length === 0) {
      return { mean: 0, stdDev: 0 };
    }
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    if (values.length < 2) {
      return { mean, stdDev: 0 };
    }
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
    const stdDev = Math.sqrt(variance);
    return { mean, stdDev };
  }

  /**
   * Record an outgoing transfer and evaluate whether it triggers a velocity anomaly.
   */
  public async recordOutgoingTransfer(params: OutgoingTransferParams): Promise<AnomalyCheckResult> {
    const now = params.timestamp ?? Date.now();
    const { accountId, amount, txHash } = params;

    const windowKey = `velocity:window:${accountId}`;
    const hourlyKey = `velocity:hourly:${accountId}`;
    const statsKey = `velocity:stats:${accountId}`;

    try {
      // 1. Record current transfer in the sliding 10-minute window (ZSET)
      // Member format: txHash:amount:timestamp
      const windowMember = `${txHash}:${amount}:${now}`;
      await this.redisClient.zadd(windowKey, now, windowMember);

      // Prune window entries older than 10 minutes
      const minWindowTime = now - this.currentWindowMs;
      await this.redisClient.zremrangebyscore(windowKey, 0, minWindowTime);

      // 2. Compute current 10-minute metrics
      const recentMembers = await this.redisClient.zrangebyscore(windowKey, minWindowTime, '+inf');
      let current10mVolume = 0;
      let current10mFrequency = recentMembers.length;

      for (const m of recentMembers) {
        const parts = m.split(':');
        if (parts.length >= 2) {
          const val = parseFloat(parts[1]);
          if (!isNaN(val)) current10mVolume += val;
        }
      }

      // 3. Update 7-day hourly baseline bucket
      const hourBucket = Math.floor(now / 3600000) * 3600000;
      const bucketHashKey = `velocity:bucket:${accountId}:${hourBucket}`;

      // Increment hourly volume and count in Redis
      await this.redisClient.hincrbyfloat(bucketHashKey, 'volume', amount);
      await this.redisClient.hincrby(bucketHashKey, 'count', 1);
      // Set TTL on bucket for 8 days to auto-clean
      await this.redisClient.expire(bucketHashKey, Math.ceil((this.baselineWindowMs + 86400000) / 1000));

      // Also register bucket timestamp in hourly index ZSET
      await this.redisClient.zadd(hourlyKey, hourBucket, String(hourBucket));
      // Prune buckets older than 7 days
      const minBaselineTime = now - this.baselineWindowMs;
      await this.redisClient.zremrangebyscore(hourlyKey, 0, minBaselineTime);

      // 4. Retrieve or compute 7-day baseline
      const baseline = await this.getBaseline(accountId, now);

      // Scale 10-minute volume to hourly equivalent (10m * 6) for comparison against hourly baseline,
      // or compare against 10m baseline (mean / 6, stdDev / sqrt(6)).
      // Mathematically: Z = (V_10m * 6 - mean_hourly) / stdDev_hourly
      const hourlyEquivalentVolume = current10mVolume * 6;
      const zScore = this.calculateZScore(
        hourlyEquivalentVolume,
        baseline.meanVolume,
        baseline.stdDevVolume
      );

      const isAnomaly = zScore > this.zScoreThreshold && current10mVolume > 0;

      const result: AnomalyCheckResult = {
        isAnomaly,
        zScore: Number(zScore.toFixed(3)),
        current10mVolume: Number(current10mVolume.toFixed(4)),
        current10mFrequency,
        baseline,
        threshold: this.zScoreThreshold,
        reason: isAnomaly
          ? `Flash velocity spike detected: current 10-min volume (${current10mVolume}) scaled exceeds 7-day baseline (mean: ${baseline.meanVolume}, stdDev: ${baseline.stdDevVolume}) with Z-score ${zScore.toFixed(2)} > ${this.zScoreThreshold}`
          : undefined,
      };

      if (isAnomaly) {
        log.warn(
          {
            accountId,
            txHash,
            zScore: result.zScore,
            current10mVolume,
            baselineMean: baseline.meanVolume,
            baselineStdDev: baseline.stdDevVolume,
          },
          '🚨 [SECURITY] Flash account draining velocity spike detected!'
        );

        // Auto-dispatch high urgency alert
        await this.dispatchSecurityAlert({
          accountId,
          walletId: params.walletId,
          userId: params.userId,
          txHash,
          amount,
          asset: params.asset ?? 'XLM',
          zScore: result.zScore,
          current10mVolume,
          baseline,
          timestamp: new Date(now).toISOString(),
        });
      }

      // Cache updated baseline stats
      await this.redisClient.set(
        statsKey,
        JSON.stringify(baseline),
        'EX',
        3600 // cache for 1 hour
      );

      return result;
    } catch (err: any) {
      log.error({ err: err?.message, accountId, txHash }, 'Error in velocity anomaly detection');
      // Graceful fallback to avoid blocking ingestion
      return {
        isAnomaly: false,
        zScore: 0,
        current10mVolume: amount,
        current10mFrequency: 1,
        baseline: {
          meanVolume: 0,
          stdDevVolume: 0,
          meanFrequency: 0,
          stdDevFrequency: 0,
          sampleCount: 0,
        },
        threshold: this.zScoreThreshold,
      };
    }
  }

  /**
   * Computes 7-day rolling baseline metrics from stored hourly buckets in Redis.
   */
  public async getBaseline(accountId: string, now: number = Date.now()): Promise<BaselineMetrics> {
    const hourlyKey = `velocity:hourly:${accountId}`;
    const minBaselineTime = now - this.baselineWindowMs;

    const bucketTimestamps = await this.redisClient.zrangebyscore(hourlyKey, minBaselineTime, '+inf');

    if (!bucketTimestamps || bucketTimestamps.length === 0) {
      return {
        meanVolume: 0,
        stdDevVolume: 0,
        meanFrequency: 0,
        stdDevFrequency: 0,
        sampleCount: 0,
      };
    }

    const volumes: number[] = [];
    const frequencies: number[] = [];

    for (const ts of bucketTimestamps) {
      const bucketHashKey = `velocity:bucket:${accountId}:${ts}`;
      const [volStr, countStr] = await Promise.all([
        this.redisClient.hget(bucketHashKey, 'volume'),
        this.redisClient.hget(bucketHashKey, 'count'),
      ]);

      const vol = parseFloat(volStr || '0');
      const count = parseInt(countStr || '0', 10);

      volumes.push(isNaN(vol) ? 0 : vol);
      frequencies.push(isNaN(count) ? 0 : count);
    }

    const volStats = this.calculateStats(volumes);
    const freqStats = this.calculateStats(frequencies);

    return {
      meanVolume: Number(volStats.mean.toFixed(4)),
      stdDevVolume: Number(volStats.stdDev.toFixed(4)),
      meanFrequency: Number(freqStats.mean.toFixed(2)),
      stdDevFrequency: Number(freqStats.stdDev.toFixed(2)),
      sampleCount: volumes.length,
    };
  }

  /**
   * Dispatches high-urgency security alert with baseline comparison metrics.
   */
  public async dispatchSecurityAlert(alertData: SecurityAlertPayload): Promise<void> {
    try {
      const jobPayload: AlertJobData = {
        paymentId: `sec-anomaly-${alertData.txHash}`,
        txHash: alertData.txHash,
        walletId: alertData.walletId ?? alertData.accountId,
        amount: String(alertData.amount),
        asset: alertData.asset,
        fromAddress: alertData.accountId,
        receivedAt: alertData.timestamp,
        severity: 'critical',
      };

      await enqueuePaymentAlert(jobPayload);

      // Publish emergency alert to realtime Redis channel
      await this.redisClient.publish(
        'security:alerts',
        JSON.stringify({
          type: 'VELOCITY_SPIKE_EMERGENCY',
          severity: 'CRITICAL',
          ...alertData,
        })
      );
    } catch (err: any) {
      log.error({ err: err?.message, alertData }, 'Failed to dispatch velocity security alert');
    }
  }
}

export const velocityAnomalyDetector = new VelocityAnomalyDetector();
