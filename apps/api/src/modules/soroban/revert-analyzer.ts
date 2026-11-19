import * as StellarSdk from 'stellar-sdk';
import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'RevertAnalyzer' });

export type SorobanErrorType =
  | 'ContractError'
  | 'HostError'
  | 'WasmTrap'
  | 'ExecutionReverted'
  | 'StorageError'
  | 'AuthorizationError'
  | 'Unknown';

export interface SorobanDiagnosticEvent {
  contractId?: string;
  topics: string[];
  data: string;
  inSuccessfulContractCall?: boolean;
}

export interface SorobanRevertAnalysis {
  txHash: string;
  failedContractId: string;
  subContractCallTree: string[];
  errorCode: number | string | null;
  errorType: SorobanErrorType;
  revertReason: string;
  diagnosticEvents: string[];
  suggestedRemediation: string;
  timestamp: string;
}

export class RevertAnalyzer {
  /**
   * Analyzes transaction result meta to extract revert reasons, error codes, and diagnostic call stacks.
   */
  public analyzeTransactionMeta(
    metaInput: string | StellarSdk.xdr.TransactionMeta | any,
    txHash: string = 'unknown_tx',
  ): SorobanRevertAnalysis | null {
    try {
      let meta: StellarSdk.xdr.TransactionMeta;

      if (typeof metaInput === 'string') {
        meta = StellarSdk.xdr.TransactionMeta.fromXDR(metaInput, 'base64');
      } else if (metaInput && typeof metaInput.switch === 'function') {
        meta = metaInput;
      } else if (metaInput && metaInput.v3) {
        meta = metaInput;
      } else {
        return this.analyzeRawResultObject(metaInput, txHash);
      }

      return this.extractFromTransactionMeta(meta, txHash);
    } catch (err) {
      logger.warn({ err }, `Failed to parse transaction meta XDR for ${txHash}`);
      return this.analyzeRawResultObject(metaInput, txHash);
    }
  }

  private extractFromTransactionMeta(
    meta: any,
    txHash: string,
  ): SorobanRevertAnalysis | null {
    const diagnosticEvents: string[] = [];
    const callTree: string[] = [];
    let failedContractId = 'unknown';
    let errorCode: number | string | null = null;
    let errorType: SorobanErrorType = 'ExecutionReverted';
    let revertReason = 'Transaction execution reverted on Soroban';

    try {
      const v3 = meta.v3 ? meta.v3() : meta;
      const sorobanMeta = v3?.sorobanMeta ? v3.sorobanMeta() : null;

      if (sorobanMeta) {
        // 1. Process Return Value if Error
        const returnValue = sorobanMeta.returnValue ? sorobanMeta.returnValue() : null;
        if (returnValue) {
          const parsedError = this.parseScValError(returnValue);
          if (parsedError) {
            errorCode = parsedError.code;
            errorType = parsedError.type;
            revertReason = parsedError.reason;
          }
        }

        // 2. Process Diagnostic Events
        const diagEvents = sorobanMeta.diagnosticEvents ? sorobanMeta.diagnosticEvents() : [];
        for (const diag of diagEvents) {
          const event = diag.event ? diag.event() : diag;
          let contractStr = '';
          if (event.contractId && event.contractId()) {
            contractStr = StellarSdk.StrKey.encodeContract(event.contractId());
            if (!callTree.includes(contractStr)) {
              callTree.push(contractStr);
            }
          }

          const topics: string[] = [];
          if (event.body) {
            const body = event.body().value ? event.body().value() : event.body();
            const rawTopics = body.topics ? body.topics() : [];
            for (const t of rawTopics) {
              topics.push(this.scValToString(t));
            }
            const dataVal = body.data ? this.scValToString(body.data()) : '';
            const diagStr = `[${contractStr || 'Host'}] Topics: [${topics.join(', ')}] Data: ${dataVal}`;
            diagnosticEvents.push(diagStr);

            // Infer sub-contract failure point from diagnostic event
            if (diagStr.toLowerCase().includes('error') || diagStr.toLowerCase().includes('fail') || diagStr.toLowerCase().includes('panic')) {
              if (contractStr) failedContractId = contractStr;
              if (!revertReason || revertReason === 'Transaction execution reverted on Soroban') {
                revertReason = diagStr;
              }
            }
          }
        }
      }
    } catch (parseErr) {
      logger.debug({ parseErr }, 'Deep meta inspection encountered error, falling back to heuristics');
    }

    if (failedContractId === 'unknown' && callTree.length > 0) {
      failedContractId = callTree[callTree.length - 1];
    }

    const suggestedRemediation = this.deriveRemediation(errorType, errorCode, revertReason);

    return {
      txHash,
      failedContractId,
      subContractCallTree: callTree,
      errorCode,
      errorType,
      revertReason,
      diagnosticEvents,
      suggestedRemediation,
      timestamp: new Date().toISOString(),
    };
  }

  private analyzeRawResultObject(obj: any, txHash: string): SorobanRevertAnalysis | null {
    if (!obj || typeof obj !== 'object') return null;

    const errorCode = obj.errorCode ?? obj.code ?? null;
    const errorType: SorobanErrorType = obj.errorType || (errorCode !== null ? 'ContractError' : 'ExecutionReverted');
    const revertReason = obj.revertReason || obj.message || obj.error || 'Execution reverted';
    const failedContractId = obj.failedContractId || obj.contractId || 'unknown';
    const subContractCallTree = Array.isArray(obj.subContractCallTree) ? obj.subContractCallTree : [failedContractId];
    const diagnosticEvents = Array.isArray(obj.diagnosticEvents) ? obj.diagnosticEvents : [];

    return {
      txHash,
      failedContractId,
      subContractCallTree,
      errorCode,
      errorType,
      revertReason,
      diagnosticEvents,
      suggestedRemediation: this.deriveRemediation(errorType, errorCode, revertReason),
      timestamp: new Date().toISOString(),
    };
  }

  private parseScValError(val: any): { code: number | string; type: SorobanErrorType; reason: string } | null {
    try {
      if (val.switch && val.switch().name === 'scvError') {
        const errorVal = val.error();
        const errType = errorVal.switch().name;

        if (errType === 'sceContract') {
          const code = errorVal.contractCode();
          return {
            code,
            type: 'ContractError',
            reason: `Contract execution panicked with ContractError #${code}`,
          };
        }
        if (errType === 'sceWasmVm') {
          return {
            code: 'WASM_TRAP',
            type: 'WasmTrap',
            reason: 'WebAssembly VM trap encountered (unreachable instruction or integer overflow)',
          };
        }
        if (errType === 'sceStorage') {
          return {
            code: 'STORAGE_ERR',
            type: 'StorageError',
            reason: 'Soroban contract storage entry missing, archived, or expired TTL',
          };
        }
        if (errType === 'sceAuth') {
          return {
            code: 'AUTH_FAILED',
            type: 'AuthorizationError',
            reason: 'Contract invocation failed authorization checks (require_auth failed)',
          };
        }
        return {
          code: errType,
          type: 'HostError',
          reason: `Soroban HostError: ${errType}`,
        };
      }
    } catch {
      // Ignore
    }
    return null;
  }

  private scValToString(scVal: any): string {
    if (!scVal) return '';
    try {
      if (scVal.switch) {
        const typeName = scVal.switch().name;
        if (typeName === 'scvSymbol' || typeName === 'scvString') {
          return scVal.value().toString('utf8');
        }
        if (typeName === 'scvU32' || typeName === 'scvI32' || typeName === 'scvU64' || typeName === 'scvI64') {
          return scVal.value().toString();
        }
        if (typeName === 'scvAddress') {
          return StellarSdk.Address.fromScVal(scVal).toString();
        }
        if (typeName === 'scvError') {
          return `Error(${scVal.error().switch().name})`;
        }
      }
      return String(scVal);
    } catch {
      return '[Unparsable ScVal]';
    }
  }

  public deriveRemediation(
    errorType: SorobanErrorType,
    errorCode: number | string | null,
    reason: string,
  ): string {
    const text = (reason + ' ' + String(errorCode)).toLowerCase();

    if (errorType === 'AuthorizationError' || text.includes('auth') || text.includes('unauthorized')) {
      return 'Verify transaction source account signatures and sub-invocation require_auth credentials.';
    }
    if (text.includes('slippage') || text.includes('min_amount') || text.includes('price')) {
      return 'Increase slippage tolerance or retry transaction with updated pool exchange rate.';
    }
    if (text.includes('expired') || text.includes('deadline')) {
      return 'Transaction deadline expired; refresh block timestamp and re-sign with fresh ledger TTL.';
    }
    if (text.includes('insufficient') || text.includes('balance') || text.includes('allowance')) {
      return 'Ensure caller has sufficient token balance and has approved an adequate allowance to the contract.';
    }
    if (errorType === 'StorageError' || text.includes('ttl') || text.includes('archived')) {
      return 'Target contract instance or storage entry has expired; restore entry TTL via extend_ttl operation.';
    }
    if (errorType === 'WasmTrap') {
      return 'WebAssembly trap triggered. Inspect parameters for division by zero, arithmetic overflow, or out-of-bounds memory access.';
    }
    return 'Inspect contract error code against contract ABI specifications and verify input parameter bounds.';
  }

  public async publishRevertAlert(analysis: SorobanRevertAnalysis): Promise<void> {
    logger.error(
      `🚨 [Soroban Revert Alert] Tx ${analysis.txHash.slice(0, 10)}... reverted in contract ${analysis.failedContractId.slice(0, 8)}... ` +
        `Error: [${analysis.errorType}] Code: ${analysis.errorCode ?? 'N/A'} - ${analysis.revertReason}. Remediation: ${analysis.suggestedRemediation}`,
    );
  }
}

export const revertAnalyzer = new RevertAnalyzer();
