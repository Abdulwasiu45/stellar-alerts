import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { createLogger } from '../lib/logger';
import { registerSupervisorHeartbeat } from './supervisor';
import { vestingWatcherService } from '../modules/soroban/vesting-watcher.service';
import { VestingSchedule, VestingAlert } from '@stellar-alerts/shared';

const logger = createLogger({ module: 'VestingWorker' });

export const vestingWorkerLifecycle = new WorkerLifecycleManager({
  workerName: 'VestingWorker',
  drainTimeoutMs: 5_000,
  maxInFlight: 10,
  autoRegisterSignals: true,
});

const DEFAULT_POLL_INTERVAL_MS = 60_000; // Check every 60 seconds
let isProcessing = false;

/**
 * Parses registered vesting contract IDs from environment.
 */
export function getMonitoredVestingContractIds(): string[] {
  const fromEnv = (process.env.VESTING_CONTRACT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return Array.from(new Set(fromEnv));
}

/**
 * Processes a single vesting contract schedule and dispatches milestone alerts.
 */
export async function processVestingContract(
  schedule: VestingSchedule,
  currentTimestampSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VestingAlert[]> {
  try {
    return await vestingWatcherService.evaluateScheduleAlerts(schedule, currentTimestampSeconds);
  } catch (err) {
    logger.error({ err, contractId: schedule.contractId }, 'Error evaluating vesting contract alerts');
    return [];
  }
}

/**
 * Runs a single pass over all monitored vesting contracts.
 */
export async function executeVestingCheckPass(
  loadSchedulesFn: () => Promise<VestingSchedule[]> = async () => [],
): Promise<VestingAlert[]> {
  if (isProcessing) return [];
  isProcessing = true;
  const emittedAlerts: VestingAlert[] = [];

  try {
    const schedules = await loadSchedulesFn();
    const nowSec = Math.floor(Date.now() / 1000);

    for (const schedule of schedules) {
      const alerts = await processVestingContract(schedule, nowSec);
      emittedAlerts.push(...alerts);
    }
  } finally {
    isProcessing = false;
  }

  return emittedAlerts;
}

export function startVestingWorker(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): NodeJS.Timeout {
  registerSupervisorHeartbeat();
  logger.info(`Starting Vesting Schedule Watcher Worker (poll interval: ${intervalMs}ms)`);

  const timer = setInterval(() => {
    executeVestingCheckPass().catch((err) => {
      logger.error({ err }, 'Unhandled error in Vesting Watcher check pass');
    });
  }, intervalMs);

  vestingWorkerLifecycle.trackInterval(timer);
  return timer;
}

export async function stopVestingWorker(): Promise<void> {
  await vestingWorkerLifecycle.drainAndShutdown('Vesting worker stopped');
}
