import { describe, it, expect, beforeEach } from 'vitest';
import {
  OracleSentinelService,
  oracleSentinelService,
  MAX_STALENESS_SECONDS,
  MAX_DIVERGENCE_PERCENT,
} from '../oracle-sentinel.service';
import { prometheusMetricsService } from '../../metrics/prometheus.service';
import { executeOracleCheckPass } from '../../../workers/oracle.worker';

describe('OracleSentinelService', () => {
  const service = new OracleSentinelService();

  beforeEach(() => {
    prometheusMetricsService.reset();
  });

  it('marks fresh oracle feed with <5% divergence as HEALTHY', () => {
    const nowMs = 1700000000000;
    const nowSec = Math.floor(nowMs / 1000);

    const oracleData = {
      oracleId: 'Reflector-XLM-1',
      oracleType: 'Reflector' as const,
      asset: 'XLM',
      price: 0.12,
      updatedAt: nowSec - 120, // 2 minutes ago (well under 10 minutes)
    };

    const cexBenchmark = {
      asset: 'XLM',
      price: 0.121, // ~0.83% divergence
      source: 'Binance',
    };

    const result = service.evaluateOracleFeed(oracleData, cexBenchmark, nowMs);

    expect(result.status).toBe('HEALTHY');
    expect(result.isStale).toBe(false);
    expect(result.isDivergent).toBe(false);
    expect(result.stalenessSeconds).toBe(120);
    expect(result.divergencePercent).toBeLessThan(MAX_DIVERGENCE_PERCENT);
    expect(result.alerts.length).toBe(0);

    const rendered = prometheusMetricsService.render();
    expect(rendered).toContain('stellar_alerts_oracle_staleness_seconds');
    expect(rendered).toContain('stellar_alerts_oracle_price_divergence_percent');
  });

  it('detects oracle price feed staleness when older than 10 minutes (600s)', () => {
    const nowMs = 1700000000000;
    const nowSec = Math.floor(nowMs / 1000);

    const oracleData = {
      oracleId: 'Reflector-XLM-Stale',
      oracleType: 'Reflector' as const,
      asset: 'XLM',
      price: 0.12,
      updatedAt: nowSec - 700, // 700 seconds old (>600s)
    };

    const cexBenchmark = {
      asset: 'XLM',
      price: 0.12,
      source: 'Binance',
    };

    const result = service.evaluateOracleFeed(oracleData, cexBenchmark, nowMs);

    expect(result.status).toBe('STALE');
    expect(result.isStale).toBe(true);
    expect(result.stalenessSeconds).toBe(700);
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0].type).toBe('ORACLE_STALENESS');
    expect(result.alerts[0].message).toContain('has not updated in 700s');
  });

  it('detects price divergence >5% from CEX benchmark', () => {
    const nowMs = 1700000000000;
    const nowSec = Math.floor(nowMs / 1000);

    const oracleData = {
      oracleId: 'Band-XLM-Divergent',
      oracleType: 'Band' as const,
      asset: 'XLM',
      price: 0.13, // On-chain price 0.13
      updatedAt: nowSec - 60, // Fresh (1 minute ago)
    };

    const cexBenchmark = {
      asset: 'XLM',
      price: 0.12, // CEX price 0.12 -> divergence is (0.01 / 0.12) = 8.33% (> 5%)
      source: 'Coinbase',
    };

    const result = service.evaluateOracleFeed(oracleData, cexBenchmark, nowMs);

    expect(result.status).toBe('DIVERGENT');
    expect(result.isDivergent).toBe(true);
    expect(result.divergencePercent).toBe(8.33);
    expect(result.alerts.length).toBe(1);
    expect(result.alerts[0].type).toBe('ORACLE_PRICE_DIVERGENCE');
    expect(result.alerts[0].severity).toBe('CRITICAL');
  });

  it('triggers CRITICAL status when an oracle is BOTH stale and divergent', () => {
    const nowMs = 1700000000000;
    const nowSec = Math.floor(nowMs / 1000);

    const oracleData = {
      oracleId: 'Band-XLM-Broken',
      oracleType: 'Band' as const,
      asset: 'XLM',
      price: 0.15,
      updatedAt: nowSec - 1200, // 20 minutes stale
    };

    const cexBenchmark = {
      asset: 'XLM',
      price: 0.12, // 25% divergence
    };

    const result = service.evaluateOracleFeed(oracleData, cexBenchmark, nowMs);

    expect(result.status).toBe('CRITICAL');
    expect(result.isStale).toBe(true);
    expect(result.isDivergent).toBe(true);
    expect(result.alerts.length).toBe(2);
  });

  it('decodes Reflector and Band protocol oracle price payloads correctly', () => {
    const reflectorRaw = { price: 0.125, timestamp: 1700000100 };
    const decodedReflector = service.decodeReflectorPrice(reflectorRaw, 'XLM');
    expect(decodedReflector.oracleType).toBe('Reflector');
    expect(decodedReflector.price).toBe(0.125);
    expect(decodedReflector.updatedAt).toBe(1700000100);

    const bandRaw = { rate: 0.124, last_updated_base: 1700000200 };
    const decodedBand = service.decodeBandPrice(bandRaw, 'XLM');
    expect(decodedBand.oracleType).toBe('Band');
    expect(decodedBand.price).toBe(0.124);
    expect(decodedBand.updatedAt).toBe(1700000200);
  });

  it('executes oracle worker check pass successfully', async () => {
    const mockOnChain = async () => ({
      oracleId: 'Mock-Oracle',
      oracleType: 'Reflector' as const,
      asset: 'XLM',
      price: 0.12,
      updatedAt: Math.floor(Date.now() / 1000) - 50,
    });

    const mockCex = async () => ({
      asset: 'XLM',
      price: 0.12,
      source: 'Binance',
    });

    const results = await executeOracleCheckPass(mockOnChain, mockCex);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].status).toBe('HEALTHY');
  });
});
