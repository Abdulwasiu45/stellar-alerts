import { prometheusMetricsService } from '../metrics/prometheus.service';
import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'OracleSentinelService' });

export type OracleProvider = 'Reflector' | 'Band' | 'Sep40' | 'Generic';

export interface OnChainOraclePrice {
  oracleId: string;
  oracleType: OracleProvider;
  asset: string;
  price: number;
  updatedAt: number; // Seconds or Epoch ms
}

export interface CexBenchmarkPrice {
  asset: string;
  price: number;
  source?: string;
  timestamp?: number;
}

export interface OracleAlert {
  type: 'ORACLE_STALENESS' | 'ORACLE_PRICE_DIVERGENCE';
  severity: 'WARNING' | 'CRITICAL';
  oracleId: string;
  oracleType: OracleProvider;
  asset: string;
  message: string;
  stalenessSeconds: number;
  divergencePercent: number;
  oraclePrice: number;
  cexPrice?: number;
  timestamp: string;
}

export interface OracleEvaluationResult {
  oracleId: string;
  oracleType: OracleProvider;
  asset: string;
  oraclePrice: number;
  cexPrice?: number;
  stalenessSeconds: number;
  isStale: boolean;
  divergencePercent: number;
  isDivergent: boolean;
  status: 'HEALTHY' | 'STALE' | 'DIVERGENT' | 'CRITICAL';
  alerts: OracleAlert[];
  timestamp: string;
}

export const MAX_STALENESS_SECONDS = 600; // 10 minutes without update
export const MAX_DIVERGENCE_PERCENT = 5.0; // 5% divergence threshold

export class OracleSentinelService {
  /**
   * Evaluates an on-chain oracle price feed against staleness bounds (>10 minutes)
   * and CEX benchmark prices (>5% divergence). Emits Prometheus latency and divergence metrics.
   */
  public evaluateOracleFeed(
    oracleData: OnChainOraclePrice,
    cexBenchmark?: CexBenchmarkPrice,
    nowMs: number = Date.now(),
  ): OracleEvaluationResult {
    const alerts: OracleAlert[] = [];
    const nowSec = Math.floor(nowMs / 1000);

    // Normalize updatedAt timestamp to seconds
    const updatedAtSec = oracleData.updatedAt > 1e11
      ? Math.floor(oracleData.updatedAt / 1000)
      : Math.floor(oracleData.updatedAt);

    const stalenessSeconds = Math.max(0, nowSec - updatedAtSec);
    const isStale = stalenessSeconds > MAX_STALENESS_SECONDS;

    let divergencePercent = 0;
    let isDivergent = false;

    if (cexBenchmark && cexBenchmark.price > 0 && oracleData.price > 0) {
      const diff = Math.abs(oracleData.price - cexBenchmark.price);
      divergencePercent = (diff / cexBenchmark.price) * 100;
      divergencePercent = Math.round(divergencePercent * 100) / 100;
      isDivergent = divergencePercent > MAX_DIVERGENCE_PERCENT;
    }

    // Determine status
    let status: 'HEALTHY' | 'STALE' | 'DIVERGENT' | 'CRITICAL' = 'HEALTHY';
    if (isStale && isDivergent) {
      status = 'CRITICAL';
    } else if (isDivergent) {
      status = 'DIVERGENT';
    } else if (isStale) {
      status = 'STALE';
    }

    // Record Prometheus metrics
    prometheusMetricsService.recordOracleLatency(
      oracleData.oracleType,
      oracleData.asset,
      stalenessSeconds,
    );

    if (cexBenchmark) {
      prometheusMetricsService.recordOracleDivergence(
        oracleData.oracleType,
        oracleData.asset,
        divergencePercent,
      );
    }

    prometheusMetricsService.incrementOracleChecks(
      oracleData.oracleType,
      oracleData.asset,
      status.toLowerCase(),
    );

    const isoTimestamp = new Date(nowMs).toISOString();

    // 1. Staleness Alert
    if (isStale) {
      alerts.push({
        type: 'ORACLE_STALENESS',
        severity: stalenessSeconds > 1800 ? 'CRITICAL' : 'WARNING',
        oracleId: oracleData.oracleId,
        oracleType: oracleData.oracleType,
        asset: oracleData.asset,
        stalenessSeconds,
        divergencePercent,
        oraclePrice: oracleData.price,
        cexPrice: cexBenchmark?.price,
        message:
          `🚨 [Oracle Staleness] ${oracleData.oracleType} oracle ${oracleData.oracleId} for ${oracleData.asset} ` +
          `has not updated in ${stalenessSeconds}s (exceeds ${MAX_STALENESS_SECONDS}s SLA).`,
        timestamp: isoTimestamp,
      });
    }

    // 2. Price Divergence Alert
    if (isDivergent && cexBenchmark) {
      alerts.push({
        type: 'ORACLE_PRICE_DIVERGENCE',
        severity: 'CRITICAL',
        oracleId: oracleData.oracleId,
        oracleType: oracleData.oracleType,
        asset: oracleData.asset,
        stalenessSeconds,
        divergencePercent,
        oraclePrice: oracleData.price,
        cexPrice: cexBenchmark.price,
        message:
          `🚨 [Price Divergence] ${oracleData.oracleType} oracle price (${oracleData.price}) deviates by ` +
          `${divergencePercent.toFixed(2)}% from CEX benchmark (${cexBenchmark.price} from ${cexBenchmark.source || 'CEX'}). Threshold: ${MAX_DIVERGENCE_PERCENT}%.`,
        timestamp: isoTimestamp,
      });
    }

    for (const a of alerts) {
      logger.warn(a.message);
    }

    return {
      oracleId: oracleData.oracleId,
      oracleType: oracleData.oracleType,
      asset: oracleData.asset,
      oraclePrice: oracleData.price,
      cexPrice: cexBenchmark?.price,
      stalenessSeconds,
      isStale,
      divergencePercent,
      isDivergent,
      status,
      alerts,
      timestamp: isoTimestamp,
    };
  }

  /**
   * Helper to decode price and timestamp from Reflector Oracle response.
   */
  public decodeReflectorPrice(raw: any, asset: string = 'XLM', oracleId: string = 'Reflector'): OnChainOraclePrice {
    const price = typeof raw?.price === 'number' ? raw.price : parseFloat(String(raw?.price || raw?.value || 0));
    const updatedAt = raw?.timestamp ? Number(raw.timestamp) : Math.floor(Date.now() / 1000);

    return {
      oracleId,
      oracleType: 'Reflector',
      asset,
      price,
      updatedAt,
    };
  }

  /**
   * Helper to decode price and timestamp from Band Protocol Oracle response.
   */
  public decodeBandPrice(raw: any, asset: string = 'XLM', oracleId: string = 'Band'): OnChainOraclePrice {
    const price = typeof raw?.rate === 'number'
      ? raw.rate
      : parseFloat(String(raw?.rate || raw?.price || 0));
    const updatedAt = raw?.last_updated_base ? Number(raw.last_updated_base) : Math.floor(Date.now() / 1000);

    return {
      oracleId,
      oracleType: 'Band',
      asset,
      price,
      updatedAt,
    };
  }
}

export const oracleSentinelService = new OracleSentinelService();
