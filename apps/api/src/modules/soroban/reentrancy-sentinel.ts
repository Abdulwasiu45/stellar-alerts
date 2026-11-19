import * as StellarSdk from 'stellar-sdk';
import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'ReentrancySentinel' });

export interface SorobanInvocationNode {
  contractId: string;
  functionName: string;
  args?: any[];
  subInvocations?: SorobanInvocationNode[];
}

export interface CallFrame {
  contractId: string;
  functionName: string;
  depth: number;
  args?: any[];
}

export interface ReentrancyIncident {
  contractId: string;
  reentrantFunction: string;
  initialDepth: number;
  reentrantDepth: number;
  callPath: string[];
  intermediateContracts: string[];
  parameters: any[];
  riskLevel: 'CRITICAL' | 'HIGH';
  description: string;
}

export interface ReentrancySecurityReport {
  txHash: string;
  hasReentrancy: boolean;
  totalInvocations: number;
  maxCallDepth: number;
  riskLevel: 'SAFE' | 'MEDIUM' | 'CRITICAL';
  incidents: ReentrancyIncident[];
  callTreeSummary: string[];
  details: string;
  timestamp: string;
}

export class ReentrancySentinel {
  /**
   * Traverses a Soroban invocation tree to identify recursive and re-entrant calls
   * across external contract execution branches.
   */
  public analyzeInvocationTree(
    root: SorobanInvocationNode | SorobanInvocationNode[],
    txHash: string = 'unknown_tx',
  ): ReentrancySecurityReport {
    const roots = Array.isArray(root) ? root : [root];
    const incidents: ReentrancyIncident[] = [];
    const callTreeSummary: string[] = [];
    let totalInvocations = 0;
    let maxCallDepth = 0;

    const traverse = (node: SorobanInvocationNode, stack: CallFrame[], depth: number) => {
      totalInvocations++;
      if (depth > maxCallDepth) maxCallDepth = depth;

      const currentContract = node.contractId;
      const currentFn = node.functionName || 'unknown_fn';
      const indent = '  '.repeat(depth);
      callTreeSummary.push(`${indent}└─ [Depth ${depth}] ${currentContract}::${currentFn}`);

      // Check for re-entrancy: Look back into the active execution stack
      // A re-entrant call occurs when the contract was already active earlier in the stack
      // and has at least one intermediate external contract between them (non-adjacent).
      const reentrantParentIndex = stack.findIndex(
        (frame, idx) => frame.contractId === currentContract && idx < stack.length - 1,
      );

      if (reentrantParentIndex !== -1) {
        const initialFrame = stack[reentrantParentIndex];
        const intermediateFrames = stack.slice(reentrantParentIndex + 1);
        const intermediateContracts = Array.from(new Set(intermediateFrames.map((f) => f.contractId)));

        const callPath = [
          ...stack.map((f) => `${f.contractId}::${f.functionName}`),
          `${currentContract}::${currentFn}`,
        ];

        incidents.push({
          contractId: currentContract,
          reentrantFunction: currentFn,
          initialDepth: initialFrame.depth,
          reentrantDepth: depth,
          callPath,
          intermediateContracts,
          parameters: node.args || [],
          riskLevel: 'CRITICAL',
          description:
            `Re-entrancy detected on contract ${currentContract} at depth ${depth} (initial entry at depth ${initialFrame.depth}). ` +
            `External intermediaries: [${intermediateContracts.join(', ')}]. Function: ${currentFn}`,
        });
      }

      // Push current frame onto active stack
      const currentFrame: CallFrame = {
        contractId: currentContract,
        functionName: currentFn,
        depth,
        args: node.args,
      };
      stack.push(currentFrame);

      // Recursively traverse sub-invocations
      if (node.subInvocations && Array.isArray(node.subInvocations)) {
        for (const child of node.subInvocations) {
          traverse(child, stack, depth + 1);
        }
      }

      // Pop frame on exit
      stack.pop();
    };

    for (const r of roots) {
      if (r && r.contractId) {
        traverse(r, [], 0);
      }
    }

    const hasReentrancy = incidents.length > 0;
    const riskLevel: 'SAFE' | 'MEDIUM' | 'CRITICAL' = hasReentrancy
      ? 'CRITICAL'
      : maxCallDepth > 4
        ? 'MEDIUM'
        : 'SAFE';

    const details = hasReentrancy
      ? `🚨 Security Alert: ${incidents.length} re-entrant call(s) detected across external contract branches.`
      : `Execution call tree verified clean. Total invocations: ${totalInvocations}, max depth: ${maxCallDepth}.`;

    return {
      txHash,
      hasReentrancy,
      totalInvocations,
      maxCallDepth,
      riskLevel,
      incidents,
      callTreeSummary,
      details,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Analyzes a linear call trace/stack representing nested execution events.
   */
  public analyzeExecutionTrace(
    trace: Array<{ contractId: string; functionName?: string; depth?: number; args?: any[] }>,
    txHash: string = 'unknown_tx',
  ): ReentrancySecurityReport {
    // Convert linear depth-annotated trace into hierarchical tree
    if (!trace || trace.length === 0) {
      return {
        txHash,
        hasReentrancy: false,
        totalInvocations: 0,
        maxCallDepth: 0,
        riskLevel: 'SAFE',
        incidents: [],
        callTreeSummary: [],
        details: 'Empty execution trace provided.',
        timestamp: new Date().toISOString(),
      };
    }

    const roots: SorobanInvocationNode[] = [];
    const stack: { depth: number; node: SorobanInvocationNode }[] = [];

    for (const entry of trace) {
      const depth = entry.depth ?? 0;
      const node: SorobanInvocationNode = {
        contractId: entry.contractId,
        functionName: entry.functionName || 'invoke',
        args: entry.args,
        subInvocations: [],
      };

      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }

      if (stack.length === 0) {
        roots.push(node);
      } else {
        const parent = stack[stack.length - 1].node;
        if (!parent.subInvocations) parent.subInvocations = [];
        parent.subInvocations.push(node);
      }

      stack.push({ depth, node });
    }

    return this.analyzeInvocationTree(roots, txHash);
  }

  /**
   * Parses and inspects transaction envelope or transaction meta XDR for invocations.
   */
  public analyzeTransactionEnvelope(
    envelopeOrXdr: string | StellarSdk.xdr.TransactionEnvelope | any,
    txHash: string = 'unknown_tx',
  ): ReentrancySecurityReport {
    try {
      let env: StellarSdk.xdr.TransactionEnvelope;
      if (typeof envelopeOrXdr === 'string') {
        env = StellarSdk.xdr.TransactionEnvelope.fromXDR(envelopeOrXdr, 'base64');
      } else if (envelopeOrXdr && typeof envelopeOrXdr.switch === 'function') {
        env = envelopeOrXdr;
      } else {
        // Fallback or simulated object
        if (envelopeOrXdr?.invocations) {
          return this.analyzeInvocationTree(envelopeOrXdr.invocations, txHash);
        }
        return this.analyzeInvocationTree([], txHash);
      }

      const invocations = this.extractInvocationsFromEnvelope(env);
      return this.analyzeInvocationTree(invocations, txHash);
    } catch (err) {
      logger.warn({ err }, `Failed to extract invocations from envelope for ${txHash}`);
      return this.analyzeInvocationTree([], txHash);
    }
  }

  private extractInvocationsFromEnvelope(env: StellarSdk.xdr.TransactionEnvelope): SorobanInvocationNode[] {
    const roots: SorobanInvocationNode[] = [];
    try {
      const tx = env.value ? (env.value() as any) : env;
      const operations = tx.tx ? (tx.tx().operations ? tx.tx().operations() : []) : [];

      for (const op of operations) {
        const body = op.body ? op.body() : op;
        if (body.switch && body.switch().name === 'invokeHostFunction') {
          const hostFnOp = body.invokeHostFunctionOp ? body.invokeHostFunctionOp() : body.value();
          const hostFn = hostFnOp.hostFunction ? hostFnOp.hostFunction() : null;

          if (hostFn && hostFn.switch && hostFn.switch().name === 'hostFunctionTypeInvokeContract') {
            const invokeArgs = hostFn.invokeContract();
            const contractAddress = invokeArgs.contractAddress();
            const functionName = invokeArgs.functionName().toString('utf8');
            const contractId = StellarSdk.Address.fromScAddress(contractAddress).toString();

            roots.push({
              contractId,
              functionName,
              args: [],
              subInvocations: [],
            });
          }
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Error traversing envelope operations');
    }
    return roots;
  }

  public async publishReentrancyAlert(report: ReentrancySecurityReport): Promise<void> {
    if (!report.hasReentrancy) return;

    logger.error(
      `🚨 [SECURITY ALERT] Re-entrancy identified in tx ${report.txHash}! ` +
        `Detected ${report.incidents.length} recursive calls. Risk: ${report.riskLevel}. Details: ${report.details}`,
    );
  }
}

export const reentrancySentinel = new ReentrancySentinel();
