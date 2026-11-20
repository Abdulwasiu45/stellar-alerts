import { WorkerLifecycleManager } from '../lib/worker-lifecycle';
import { registerSupervisorHeartbeat } from './supervisor';
import {
  WasmAuditSentinel,
  wasmAuditSentinel,
  WasmAuditResult,
} from '../modules/soroban/wasm-sentinel.service';
import { createLogger } from '../lib/logger';

const logger = createLogger({ module: 'WasmSentinelWorker' });

export const wasmSentinelLifecycle = new WorkerLifecycleManager({
  workerName: 'WasmSentinelWorker',
  drainTimeoutMs: 5_000,
  maxInFlight: 5,
  autoRegisterSignals: true,
});

export type WasmAuditNotifier = (result: WasmAuditResult) => Promise<void> | void;

export const defaultWasmAuditNotifier: WasmAuditNotifier = (result) => {
  if (result.warningAlert) {
    logger.warn(
      `[WasmSentinelWorker] 🚨 UNVERIFIED BYTECODE on ${result.contractId} (hash: ${result.wasmHash.slice(0, 12)}...): ${result.warningAlert.message}`,
    );
  } else {
    logger.info(
      `[WasmSentinelWorker] ✅ VERIFIED contract ${result.contractId} against ${result.verifiedInfo?.protocol}`,
    );
  }
};

export interface WasmSentinelPassDeps {
  sentinel?: WasmAuditSentinel;
  contractIds?: string[];
  notify?: WasmAuditNotifier;
  fetchBytecode?: (contractId: string) => Promise<Buffer | null>;
  persist?: boolean;
}

/**
 * Runs an audit pass over monitored contract IDs to verify bytecode against known audit registries.
 */
export async function runWasmAuditPass(deps: WasmSentinelPassDeps = {}): Promise<WasmAuditResult[]> {
  const sentinel = deps.sentinel ?? wasmAuditSentinel;
  const notify = deps.notify ?? defaultWasmAuditNotifier;
  const contractIds = deps.contractIds ?? [];
  const results: WasmAuditResult[] = [];

  for (const contractId of contractIds) {
    try {
      const bytecode = deps.fetchBytecode
        ? await deps.fetchBytecode(contractId)
        : await sentinel.fetchContractBytecode(contractId);

      if (!bytecode) {
        logger.debug({ contractId }, 'No bytecode retrieved for contract');
        continue;
      }

      const auditResult = await sentinel.verifyBytecode(contractId, bytecode, {
        persist: deps.persist ?? false,
      });

      results.push(auditResult);
      await notify(auditResult);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ contractId, err: msg }, 'Error auditing contract WASM bytecode');
    }
  }

  return results;
}

let wasmIntervalId: NodeJS.Timeout | null = null;

export function startWasmSentinelWorker(intervalMs = 60000) {
  registerSupervisorHeartbeat();
  wasmIntervalId = setInterval(async () => {
    await wasmSentinelLifecycle.withTask(async () => {
      await runWasmAuditPass();
    });
  }, intervalMs);
}

export function stopWasmSentinelWorker() {
  if (wasmIntervalId) {
    clearInterval(wasmIntervalId);
    wasmIntervalId = null;
  }
}
