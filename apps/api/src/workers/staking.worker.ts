import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { createLogger } from '../lib/logger';
import { registerSupervisorHeartbeat } from './supervisor';
import { stakingSentinelService, StakingEvent, StakingTvlAlert } from '../modules/soroban/staking-sentinel.service';
import { prisma } from '../lib/prisma';
import { fetchContractEvents, getSorobanLatestLedger } from '../lib/soroban';

const logger = createLogger({ module: 'StakingWorker' });

export const stakingWorkerLifecycle = new WorkerLifecycleManager({
  workerName: 'StakingWorker',
  drainTimeoutMs: 5_000,
  maxInFlight: 10,
  autoRegisterSignals: true,
});

const DEFAULT_POLL_INTERVAL_MS = 30_000;
let isProcessing = false;

export function getMonitoredStakingPoolIds(): string[] {
  const fromEnv = (process.env.STAKING_POOL_CONTRACT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return Array.from(new Set(fromEnv));
}

/**
 * Parses Soroban contract event topics and data into a standard StakingEvent.
 */
export function parseStakingEvent(rawEvent: any, poolId: string): StakingEvent | null {
  try {
    const topic = Array.isArray(rawEvent.topic)
      ? rawEvent.topic.map((t: any) => String(t).toLowerCase())
      : [];

    const isDeposit = topic.some((t: string) => t.includes('deposit') || t.includes('stake'));
    const isWithdraw = topic.some((t: string) => t.includes('withdraw') || t.includes('unstake') || t.includes('claim'));

    if (!isDeposit && !isWithdraw) {
      return null;
    }

    let amount = 0;
    if (typeof rawEvent.amount === 'number') {
      amount = rawEvent.amount;
    } else if (rawEvent.amount) {
      amount = parseFloat(String(rawEvent.amount)) || 0;
    } else if (rawEvent.value?.amount) {
      amount = parseFloat(String(rawEvent.value.amount)) || 0;
    }

    if (amount <= 0) return null;

    return {
      poolId,
      type: isWithdraw ? 'withdraw' : 'deposit',
      amount,
      timestamp: rawEvent.timestamp ? new Date(rawEvent.timestamp).getTime() : Date.now(),
      account: rawEvent.account || rawEvent.from || rawEvent.to,
      txHash: rawEvent.txHash || rawEvent.transaction_hash,
    };
  } catch (err) {
    logger.debug({ err }, 'Failed to parse staking event');
    return null;
  }
}

/**
 * Processes a single staking pool contract, ingesting new deposit/withdraw events.
 */
export async function processStakingPool(poolId: string): Promise<StakingTvlAlert | null> {
  try {
    const latestLedger = await getSorobanLatestLedger();
    if (latestLedger === 0) return null;

    const events = await fetchContractEvents(poolId, Math.max(1, latestLedger - 100));
    let latestAlert: StakingTvlAlert | null = null;

    for (const raw of events) {
      const stakingEvent = parseStakingEvent(raw, poolId);
      if (stakingEvent) {
        const alert = await stakingSentinelService.recordEvent(stakingEvent);
        if (alert) {
          latestAlert = alert;
        }
      }
    }

    // Also check current 1-hour window status
    const shiftAlert = await stakingSentinelService.checkTvlShift(poolId);
    return shiftAlert || latestAlert;
  } catch (error) {
    logger.error({ error, poolId }, 'Error evaluating staking pool TVL');
    return null;
  }
}

/**
 * Worker polling loop executing checks across all monitored staking pools.
 */
export async function executeStakingCheckPass(): Promise<StakingTvlAlert[]> {
  if (isProcessing) return [];
  isProcessing = true;
  const alerts: StakingTvlAlert[] = [];

  try {
    const poolIds = getMonitoredStakingPoolIds();
    for (const poolId of poolIds) {
      const alert = await processStakingPool(poolId);
      if (alert) {
        alerts.push(alert);
      }
    }
  } finally {
    isProcessing = false;
  }

  return alerts;
}

export function startStakingWorker(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): NodeJS.Timeout {
  registerSupervisorHeartbeat();
  logger.info(`Starting Staking Sentinel Worker (poll interval: ${intervalMs}ms)`);

  const timer = setInterval(() => {
    executeStakingCheckPass().catch((err) => {
      logger.error({ err }, 'Unhandled error in Staking Sentinel check pass');
    });
  }, intervalMs);

  stakingWorkerLifecycle.trackInterval(timer);
  return timer;
}

export async function stopStakingWorker(): Promise<void> {
  await stakingWorkerLifecycle.drainAndShutdown('Worker stopped');
}
