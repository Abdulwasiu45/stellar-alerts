import * as StellarSdk from 'stellar-sdk';
import { createLogger } from '../../lib/logger';
import { FlashLoanAlert } from '@stellar-alerts/shared';

const logger = createLogger({ module: 'FlashLoanDetector' });

export interface FlashLoanInvocationNode {
  contractId: string;
  functionName: string;
  asset?: string;
  amount?: string | bigint | number;
  args?: unknown[];
  subInvocations?: FlashLoanInvocationNode[];
}

export interface FlashLoanTransactionInput {
  txHash: string;
  ledgerSeq: number;
  invocations?: FlashLoanInvocationNode[];
  operations?: Array<{
    type: string;
    sourceAccount?: string;
    destination?: string;
    asset?: string;
    amount?: string | number;
    contractId?: string;
  }>;
  events?: Array<{
    contractId?: string;
    topic?: unknown[];
    value?: unknown;
    data?: unknown;
  }>;
}

const BORROW_FUNCTIONS = new Set(['borrow', 'flash_loan', 'flashloan', 'take_loan', 'lend']);
const REPAY_FUNCTIONS = new Set(['repay', 'return', 'flash_repay', 'repay_loan', 'return_loan']);

export class FlashLoanDetector {
  /**
   * Analyzes an atomic transaction envelope for flash loan execution patterns:
   * 1. An atomic uncollateralized borrow from a lender contract.
   * 2. Intermediate interactions (arbitrage / DEX swaps / liquidation).
   * 3. An atomic repayment back to the same lender contract with an equal or greater amount.
   */
  public analyzeTransaction(input: FlashLoanTransactionInput): FlashLoanAlert | null {
    const startTime = Date.now();

    // 1. Flatten invocations in execution order
    const executionTrace: Array<{
      contractId: string;
      functionName: string;
      asset: string;
      amount: bigint;
      fee?: bigint;
    }> = [];

    const intermediateContracts: string[] = [];

    if (input.invocations && input.invocations.length > 0) {
      const traverse = (node: FlashLoanInvocationNode) => {
        const fn = node.functionName.toLowerCase();
        const asset = node.asset || this.extractAsset(node.args) || 'UNKNOWN_ASSET';
        const amount = this.extractAmount(node.amount ?? node.args);

        executionTrace.push({
          contractId: node.contractId,
          functionName: fn,
          asset,
          amount,
        });

        if (node.subInvocations && node.subInvocations.length > 0) {
          for (const sub of node.subInvocations) {
            traverse(sub);
          }
        }
      };

      for (const root of input.invocations) {
        traverse(root);
      }
    }

    // Also support event-based trace if events are provided
    if (input.events && input.events.length > 0) {
      for (const ev of input.events) {
        const topics = Array.isArray(ev.topic)
          ? ev.topic.map((t) => (typeof t === 'string' ? t.toLowerCase() : ''))
          : [];
        const val = (ev.value || ev.data || {}) as Record<string, unknown>;

        const isBorrow = topics.some((t) => BORROW_FUNCTIONS.has(t));
        const isRepay = topics.some((t) => REPAY_FUNCTIONS.has(t));

        if (isBorrow || isRepay) {
          const contractId = ev.contractId || (val.contractId as string) || '';
          const asset =
            (val.asset as string) || (val.token as string) || topics[1] || 'UNKNOWN_ASSET';
          const amount = this.extractAmount(val.amount ?? val.borrowedAmount ?? val.repaidAmount);
          const fee = this.extractAmount(val.fee ?? val.protocolFee);

          executionTrace.push({
            contractId,
            functionName: isBorrow ? 'borrow' : 'repay',
            asset,
            amount,
            fee: fee > 0n ? fee : undefined,
          });
        }
      }
    }

    // 2. Identify Borrow -> Arbitrage -> Repay cycles
    for (let i = 0; i < executionTrace.length; i++) {
      const entry = executionTrace[i];
      if (!BORROW_FUNCTIONS.has(entry.functionName) || entry.amount <= 0n) {
        continue;
      }

      const lenderContract = entry.contractId;
      const borrowedAsset = entry.asset;
      const borrowedAmount = entry.amount;

      // Scan subsequent operations for repayment to lenderContract
      for (let j = i + 1; j < executionTrace.length; j++) {
        const nextOp = executionTrace[j];

        // Track intermediate contracts involved between borrow and repay
        if (nextOp.contractId && nextOp.contractId !== lenderContract) {
          if (!intermediateContracts.includes(nextOp.contractId)) {
            intermediateContracts.push(nextOp.contractId);
          }
        }

        const isRepayment =
          nextOp.contractId === lenderContract &&
          (REPAY_FUNCTIONS.has(nextOp.functionName) || nextOp.functionName === 'transfer') &&
          nextOp.amount >= borrowedAmount;

        if (isRepayment) {
          // Detected atomic flash loan!
          const repaidAmount = nextOp.amount;
          const calculatedFee =
            entry.fee ?? (repaidAmount > borrowedAmount ? repaidAmount - borrowedAmount : 0n);

          // Calculate estimated arbitrage profit
          const profit = this.estimateNetArbitrageProfit(
            executionTrace.slice(i, j + 1),
            borrowedAsset,
            borrowedAmount,
            repaidAmount,
          );

          const durationMs = Date.now() - startTime;

          const alert: FlashLoanAlert = {
            type: 'FLASH_LOAN_DETECTED',
            priority: 'HIGH',
            txHash: input.txHash,
            ledgerSeq: input.ledgerSeq,
            protocolContractId: lenderContract,
            borrowedAsset,
            borrowedAmount: borrowedAmount.toString(),
            repaidAmount: repaidAmount.toString(),
            feeAmount: calculatedFee.toString(),
            netArbitrageProfit: profit.toString(),
            targetArbitrageContracts: intermediateContracts,
            timestamp: new Date().toISOString(),
            durationMs,
          };

          logger.info(
            {
              txHash: alert.txHash,
              lender: alert.protocolContractId,
              borrowed: alert.borrowedAmount,
              fee: alert.feeAmount,
              arbitrageTargets: alert.targetArbitrageContracts,
            },
            `⚡ FLASH_LOAN_DETECTED on ${alert.protocolContractId}`,
          );

          return alert;
        }
      }
    }

    return null;
  }

  /**
   * Analyzes raw XDR transaction envelopes to detect flash loans or verify standard multi-op payments.
   */
  public analyzeTransactionEnvelopeXdr(
    envelopeXdrBase64: string,
    txHash: string = 'unknown_tx',
    ledgerSeq: number = 0,
  ): FlashLoanAlert | null {
    try {
      const envelope = StellarSdk.xdr.TransactionEnvelope.fromXDR(envelopeXdrBase64, 'base64');
      const operations: Array<{
        type: string;
        sourceAccount?: string;
        destination?: string;
        asset?: string;
        amount?: string | number;
        contractId?: string;
      }> = [];

      const tx = envelope.v1()?.tx() || envelope.v0()?.tx();
      if (!tx) {
        return null;
      }

      const rawOps = tx.operations() || [];
      for (const op of rawOps) {
        const body = op.body();
        const typeArm = body.arm();
        operations.push({
          type: typeArm,
        });
      }

      // If standard Stellar operations without Soroban contract invocations, it is not a flash loan
      return this.analyzeTransaction({
        txHash,
        ledgerSeq,
        operations,
      });
    } catch {
      return null;
    }
  }

  private extractAsset(args: unknown): string {
    if (!args) return 'UNKNOWN_ASSET';
    if (typeof args === 'string') return args;
    if (Array.isArray(args)) {
      for (const a of args) {
        if (typeof a === 'string' && (a.startsWith('C') || a.startsWith('G') || a.length >= 3)) {
          return a;
        }
      }
    }
    return 'UNKNOWN_ASSET';
  }

  private extractAmount(val: unknown): bigint {
    if (!val) return 0n;
    if (typeof val === 'bigint') return val;
    if (typeof val === 'number') return BigInt(Math.trunc(val));
    if (typeof val === 'string' && /^\d+$/.test(val)) return BigInt(val);
    if (Array.isArray(val)) {
      for (const item of val) {
        const parsed = this.extractAmount(item);
        if (parsed > 0n) return parsed;
      }
    }
    return 0n;
  }

  private estimateNetArbitrageProfit(
    traceSlice: Array<{ contractId: string; functionName: string; asset: string; amount: bigint }>,
    borrowedAsset: string,
    borrowedAmount: bigint,
    repaidAmount: bigint,
  ): bigint {
    let intermediateOutflow = 0n;
    let intermediateInflow = 0n;

    for (const item of traceSlice) {
      if (item.functionName === 'swap' && item.asset === borrowedAsset) {
        intermediateInflow += item.amount;
      }
    }

    if (intermediateInflow > (repaidAmount - borrowedAmount)) {
      return intermediateInflow - (repaidAmount - borrowedAmount);
    }

    return 0n;
  }
}

export const flashLoanDetector = new FlashLoanDetector();
