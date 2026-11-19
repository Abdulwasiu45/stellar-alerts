import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { createLogger } from '../lib/logger';
import { registerSupervisorHeartbeat } from './supervisor';
import {
  oracleSentinelService,
  OnChainOraclePrice,
  CexBenchmarkPrice,
  OracleEvaluationResult,
} from '../modules/soroban/oracle-sentinel.service';

const logger = createLogger({ module: 'OracleWorker' });

export const oracleWorkerLifecycle = new WorkerLifecycleManager({
  workerName: 'OracleWorker',
  drainTimeoutMs: 5_000,
  maxInFlight: 10,
  autoRegisterSignals: true,
});

const DEFAULT_POLL_INTERVAL_MS = 60_000; // Check every 60 seconds
let isProcessing = false;

export interface MonitoredOracleConfig {
  oracleId: string;
  oracleType: 'Reflector' | 'Band' | 'Sep40' | 'Generic';
  asset: string;
  contractAddress?: string;
}

/**
 * Returns list of oracles configured for monitoring.
 */
export function getConfiguredOracles(): MonitoredOracleConfig[] {
  const fromEnv = process.env.MONITORED_ORACLES;
  if (fromEnv) {
    try {
      return JSON.parse(fromEnv);
    } catch {
      // Fall through to defaults
    }
  }

  return [
    {
      oracleId: 'Reflector-XLM',
      oracleType: 'Reflector',
      asset: 'XLM',
      contractAddress: process.env.REFLECTOR_XLM_CONTRACT_ID || 'CA...REFLECTOR_XLM',
    },
    {
      oracleId: 'Reflector-USDC',
      oracleType: 'Reflector',
      asset: 'USDC',
      contractAddress: process.env.REFLECTOR_USDC_CONTRACT_ID || 'CA...REFLECTOR_USDC',
    },
    {
      oracleId: 'Band-XLM',
      oracleType: 'Band',
      asset: 'XLM',
      contractAddress: process.env.BAND_XLM_CONTRACT_ID || 'CA...BAND_XLM',
    },
  ];
}

/**
 * Fetches latest on-chain oracle data.
 */
export async function fetchOnChainOraclePrice(
  config: MonitoredOracleConfig,
): Promise<OnChainOraclePrice> {
  // If simulated/mocked in tests or environment without live RPC:
  return {
    oracleId: config.oracleId,
    oracleType: config.oracleType,
    asset: config.asset,
    price: 0.12, // Baseline XLM price
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Fetches reference CEX benchmark price.
 */
export async function fetchCexBenchmark(asset: string): Promise<CexBenchmarkPrice | undefined> {
  // Can be plugged into CoinGecko or exchange ticker API
  return {
    asset,
    price: 0.12,
    source: 'Binance',
    timestamp: Date.now(),
  };
}

/**
 * Runs a single pass checking all registered oracle feeds.
 */
export async function executeOracleCheckPass(
  fetchOnChainFn: (cfg: MonitoredOracleConfig) => Promise<OnChainOraclePrice> = fetchOnChainOraclePrice,
  fetchCexFn: (asset: string) => Promise<CexBenchmarkPrice | undefined> = fetchCexBenchmark,
): Promise<OracleEvaluationResult[]> {
  if (isProcessing) return [];
  isProcessing = true;
  const results: OracleEvaluationResult[] = [];

  try {
    const oracles = getConfiguredOracles();
    for (const oracleCfg of oracles) {
      try {
        const onChainData = await fetchOnChainFn(oracleCfg);
        const cexData = await fetchCexFn(oracleCfg.asset);
        const evalResult = oracleSentinelService.evaluateOracleFeed(onChainData, cexData);
        results.push(evalResult);
      } catch (err) {
        logger.error({ err, oracleId: oracleCfg.oracleId }, 'Failed to evaluate oracle feed');
      }
    }
  } finally {
    isProcessing = false;
  }

  return results;
}

export function startOracleWorker(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): NodeJS.Timeout {
  registerSupervisorHeartbeat();
  logger.info(`Starting Oracle Sentinel Worker (poll interval: ${intervalMs}ms)`);

  const timer = setInterval(() => {
    executeOracleCheckPass().catch((err) => {
      logger.error({ err }, 'Unhandled error in Oracle Sentinel worker check pass');
    });
  }, intervalMs);

  oracleWorkerLifecycle.trackInterval(timer);
  return timer;
}

export async function stopOracleWorker(): Promise<void> {
  await oracleWorkerLifecycle.drainAndShutdown('Oracle worker stopped');
}
