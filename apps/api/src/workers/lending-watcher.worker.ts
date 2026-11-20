import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { registerSupervisorHeartbeat } from './supervisor';
import {
  LendingTrackerService,
  lendingTrackerService,
} from '../modules/soroban/lending-tracker.service';
import { LendingAlert, LendingPosition, LiquidationEvent } from '@stellar-alerts/shared';
import { createLogger } from '../lib/logger';

const logger = createLogger({ module: 'LendingWatcherWorker' });

export const lendingWatcherLifecycle = new WorkerLifecycleManager({
  workerName: 'LendingWatcher',
  drainTimeoutMs: 5_000,
  maxInFlight: 10,
  autoRegisterSignals: true,
});

export type LendingAlertNotifier = (alert: LendingAlert) => Promise<void> | void;

export const defaultLendingNotifier: LendingAlertNotifier = (alert) => {
  logger.info(
    `[LendingWatcher] 📢 ${alert.severity} alert for ${alert.userAddress} on ${alert.protocol} (${alert.type}): ${alert.message}`,
  );
};

export interface LendingWatcherPassDeps {
  service?: LendingTrackerService;
  positions?: LendingPosition[];
  notify?: LendingAlertNotifier;
  priceOverrides?: Record<string, number>;
}

/**
 * Runs a single evaluation pass across all monitored lending positions.
 */
export async function runLendingWatcherPass(
  deps: LendingWatcherPassDeps = {},
): Promise<LendingAlert[]> {
  const service = deps.service ?? lendingTrackerService;
  const notify = deps.notify ?? defaultLendingNotifier;
  const positions = deps.positions ?? service.getAllPositions();
  const alerts: LendingAlert[] = [];

  for (const pos of positions) {
    try {
      const hf = service.calculateHealthFactor(pos.collaterals, pos.debts, deps.priceOverrides);
      pos.healthFactor = hf.healthFactor;
      pos.isLiquidatable = hf.isLiquidatable;
      pos.updatedAt = new Date().toISOString();

      const alert = service.evaluatePositionAlert(pos, pos.warningThreshold);
      if (alert) {
        alerts.push(alert);
        await notify(alert);
      }
    } catch (err) {
      logger.error({ err, userAddress: pos.userAddress }, 'Failed evaluating lending position');
    }
  }

  return alerts;
}

/**
 * Processes a raw liquidation contract event and triggers notification if parsed.
 */
export async function processLiquidationEvent(
  rawEvent: {
    topic?: unknown[];
    value?: unknown;
    data?: unknown;
    contractId?: string;
    txHash?: string;
    ledgerSeq?: number;
  },
  deps: {
    service?: LendingTrackerService;
    notify?: LendingAlertNotifier;
  } = {},
): Promise<LiquidationEvent | null> {
  const service = deps.service ?? lendingTrackerService;
  const notify = deps.notify ?? defaultLendingNotifier;

  const parsed = service.parseLiquidationEvent(rawEvent);
  if (!parsed) return null;

  const alert: LendingAlert = {
    type: 'LIQUIDATION_EXECUTED',
    severity: 'CRITICAL',
    userAddress: parsed.borrower,
    contractId: parsed.contractId,
    protocol: parsed.protocol,
    liquidationDetails: parsed,
    message:
      `CRITICAL: Liquidation executed on ${parsed.protocol} (contract ${parsed.contractId})! ` +
      `Liquidator ${parsed.liquidator} seized ${parsed.collateralSeized} ${parsed.collateralAsset} from borrower ${parsed.borrower} ` +
      `by repaying ${parsed.debtRepaid} ${parsed.debtAsset}. Tx: ${parsed.txHash}`,
    timestamp: parsed.timestamp,
  };

  await notify(alert);
  return parsed;
}

let pollInterval: NodeJS.Timeout | null = null;

export function startLendingWatcher(intervalMs = 30000) {
  registerSupervisorHeartbeat();
  pollInterval = setInterval(async () => {
    await lendingWatcherLifecycle.runTask(async () => {
      await runLendingWatcherPass();
    });
  }, intervalMs);
}

export function stopLendingWatcher() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
