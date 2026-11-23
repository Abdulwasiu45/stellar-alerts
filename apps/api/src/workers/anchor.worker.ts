import { prisma } from '../lib/prisma';
import { registerSupervisorHeartbeat } from './supervisor';
import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { anchorLifecycleWatcher, type AnchorLifecycleWatcher } from '../modules/stellar/anchor-watcher.service';

/**
 * Runs the unified SEP-24 / SEP-31 anchor lifecycle watcher
 * (modules/stellar/anchor-watcher.service.ts) on a fixed interval. On-chain
 * correlation happens in the payment watcher as payments are ingested; this
 * worker drives the off-chain status polling.
 *
 * Supersedes anchor-watcher.worker.ts, which only polled statuses.
 */
export const anchorLifecycle = new WorkerLifecycleManager({
  workerName: 'AnchorWorker',
  drainTimeoutMs: 10_000,
  maxInFlight: 10,
  autoRegisterSignals: true,
});

const POLL_INTERVAL_MS = Number(process.env.ANCHOR_WATCHER_INTERVAL_MS) || 30_000;

export async function runAnchorWorkerPass(watcher: AnchorLifecycleWatcher = anchorLifecycleWatcher) {
  return watcher.pollAll();
}

export async function runAnchorWorker() {
  console.log('[AnchorWorker] 🚀 Starting SEP-24 / SEP-31 anchor lifecycle watcher...');

  anchorLifecycle.registerCleanup('prisma', async () => {
    await prisma.$disconnect();
  });

  const poll = () =>
    anchorLifecycle.runTask(async () => {
      try {
        await runAnchorWorkerPass();
      } catch (error: any) {
        console.error('[AnchorWorker] Polling error:', error?.message || error);
      }
    });

  await poll();
  anchorLifecycle.trackInterval(setInterval(poll, POLL_INTERVAL_MS));
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  void runAnchorWorker();
}
