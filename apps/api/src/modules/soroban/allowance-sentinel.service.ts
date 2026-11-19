import * as StellarSdk from 'stellar-sdk';
import { prisma } from '../../lib/prisma';
import { redis, fallbackMemoryCache, isRedisDegraded } from '../../lib/redis';
import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'AllowanceSentinelService' });

export const MAX_I64 = 9223372036854775807n;
export const MAX_I128 = (1n << 127n) - 1n;
export const MAX_U128 = (1n << 128n) - 1n;
export const INFINITE_ALLOWANCE_THRESHOLD = 1n << 60n; // Approvals >= 2^60 are considered unlimited/infinite
export const EXCESSIVE_ALLOWANCE_THRESHOLD_UNITS = 10_000_000n; // 10,000,000 base units

export interface TokenApprovalEvent {
  tokenContractId: string;
  owner: string;
  spender: string;
  amount: string;
  rawAmount: bigint;
  liveUntilLedger: number;
  ledgerSeq?: number;
  txHash?: string;
  timestamp?: string;
}

export interface SpenderAuthorizationRecord {
  walletAddress: string;
  tokenContractId: string;
  spenderAddress: string;
  allowanceAmount: string;
  isUnlimited: boolean;
  grantedAtLedger: number;
  liveUntilLedger: number;
  txHash?: string;
  updatedAt: string;
}

export interface UnlimitedAllowanceAlert {
  type: 'UNLIMITED_ALLOWANCE_GRANTED' | 'EXCESSIVE_ALLOWANCE_GRANTED';
  severity: 'CRITICAL' | 'WARNING';
  walletAddress: string;
  tokenContractId: string;
  spenderAddress: string;
  allowanceAmount: string;
  isUnlimited: boolean;
  ceilingDescription: string;
  riskRecommendation: string;
  txHash?: string;
  timestamp: string;
}

export class AllowanceSentinelService {
  /**
   * Checks whether the given allowance amount represents an unlimited or max-integer grant.
   */
  public isUnlimitedAllowance(amount: bigint | number | string): boolean {
    try {
      const bn = typeof amount === 'bigint' ? amount : BigInt(String(amount));
      return (
        bn >= INFINITE_ALLOWANCE_THRESHOLD ||
        bn === MAX_I64 ||
        bn === MAX_I128 ||
        bn === MAX_U128
      );
    } catch {
      return false;
    }
  }

  /**
   * Checks whether the given allowance exceeds the 10,000,000 unit threshold.
   */
  public isExcessiveAllowance(amount: bigint | number | string, decimals: number = 7): boolean {
    try {
      const bn = typeof amount === 'bigint' ? amount : BigInt(String(amount));
      const thresholdWithDecimals = EXCESSIVE_ALLOWANCE_THRESHOLD_UNITS * (10n ** BigInt(decimals));
      return bn >= thresholdWithDecimals || bn >= EXCESSIVE_ALLOWANCE_THRESHOLD_UNITS;
    } catch {
      return false;
    }
  }

  /**
   * Parses raw Soroban / SAC approval contract events into structured TokenApprovalEvent.
   */
  public parseApprovalEvent(raw: any, tokenContractId: string): TokenApprovalEvent | null {
    try {
      const rawTopics: string[] = Array.isArray(raw.topic) ? raw.topic.map((t: any) => String(t)) : [];
      const lowerTopics: string[] = rawTopics.map((t: string) => t.toLowerCase());

      // Check if event topic represents an 'approve' event
      const isApprove = lowerTopics.some((t: string) => t.includes('approve') || t === 'approval');
      if (!isApprove) {
        return null;
      }

      let from = raw.from || raw.owner || '';
      let spender = raw.spender || raw.to || '';
      let rawAmount = 0n;
      let liveUntilLedger = typeof raw.liveUntilLedger === 'number' ? raw.liveUntilLedger : 0;

      if (raw.amount !== undefined && raw.amount !== null) {
        rawAmount = BigInt(String(raw.amount));
      } else if (raw.value?.amount !== undefined) {
        rawAmount = BigInt(String(raw.value.amount));
      }

      if (raw.value?.live_until_ledger !== undefined) {
        liveUntilLedger = Number(raw.value.live_until_ledger);
      } else if (raw.live_until_ledger !== undefined) {
        liveUntilLedger = Number(raw.live_until_ledger);
      }

      // If from/spender in topics, use original raw string to preserve casing
      if (!from && rawTopics.length > 1) {
        from = rawTopics[1];
      }
      if (!spender && rawTopics.length > 2) {
        spender = rawTopics[2];
      }

      return {
        tokenContractId,
        owner: from,
        spender,
        amount: rawAmount.toString(),
        rawAmount,
        liveUntilLedger,
        ledgerSeq: raw.ledgerSeq || raw.ledger,
        txHash: raw.txHash || raw.transaction_hash,
        timestamp: raw.timestamp ? new Date(raw.timestamp).toISOString() : new Date().toISOString(),
      };
    } catch (err) {
      logger.debug({ err }, 'Failed parsing approval event');
      return null;
    }
  }

  /**
   * Evaluates an observed token approval event for unlimited allowances or thresholds > 10,000,000 units.
   * If flagged, records the authorization in the database/store and generates a security alert.
   */
  public async inspectApproval(event: TokenApprovalEvent): Promise<UnlimitedAllowanceAlert | null> {
    const isUnlimited = this.isUnlimitedAllowance(event.rawAmount);
    const isExcessive = this.isExcessiveAllowance(event.rawAmount);

    if (!isUnlimited && !isExcessive) {
      return null;
    }

    const alertType = isUnlimited
      ? 'UNLIMITED_ALLOWANCE_GRANTED'
      : 'EXCESSIVE_ALLOWANCE_GRANTED';

    const severity = isUnlimited ? 'CRITICAL' : 'WARNING';
    const ceilingDescription = isUnlimited
      ? `Unlimited allowance (${event.rawAmount} raw units, near max integer)`
      : `Excessive allowance of ${event.amount} units (exceeds ${EXCESSIVE_ALLOWANCE_THRESHOLD_UNITS} unit threshold)`;

    const riskRecommendation =
      'Third-party spender granted high-risk allowance. ' +
      'Revoke or reduce allowance to zero via SAC approve(spender, 0) when dApp interaction completes to mitigate phishing drain risks.';

    const alert: UnlimitedAllowanceAlert = {
      type: alertType,
      severity,
      walletAddress: event.owner,
      tokenContractId: event.tokenContractId,
      spenderAddress: event.spender,
      allowanceAmount: event.amount,
      isUnlimited,
      ceilingDescription,
      riskRecommendation,
      txHash: event.txHash,
      timestamp: event.timestamp || new Date().toISOString(),
    };

    logger.warn(
      `🚨 [${alertType}] Wallet ${event.owner.slice(0, 8)}... approved ${event.spender.slice(0, 8)}... ` +
        `for ${ceilingDescription} on token ${event.tokenContractId.slice(0, 8)}...`,
    );

    // Record authorization in persistent storage
    await this.recordSpenderAuthorization({
      walletAddress: event.owner,
      tokenContractId: event.tokenContractId,
      spenderAddress: event.spender,
      allowanceAmount: event.amount,
      isUnlimited,
      grantedAtLedger: event.ledgerSeq || 0,
      liveUntilLedger: event.liveUntilLedger,
      txHash: event.txHash,
      updatedAt: new Date().toISOString(),
    });

    return alert;
  }

  /**
   * Records or updates active spender authorization in database and cache.
   */
  public async recordSpenderAuthorization(record: SpenderAuthorizationRecord): Promise<void> {
    const cacheKey = `stellar:allowance:${record.walletAddress}:${record.tokenContractId}:${record.spenderAddress}`;
    const payload = JSON.stringify(record);

    fallbackMemoryCache.set(cacheKey, payload, 86400 * 7);

    try {
      if (!isRedisDegraded()) {
        await redis.set(cacheKey, payload, 'EX', 86400 * 7);
      }
    } catch {
      // Degraded Redis
    }

    try {
      await prisma.sorobanEventSnapshot.create({
        data: {
          contractId: record.tokenContractId,
          from: record.walletAddress,
          to: record.spenderAddress,
          amount: record.allowanceAmount,
          ledgerSeq: record.grantedAtLedger || 1,
          eventType: 'spender_allowance',
          txHash: record.txHash || null,
        },
      });
    } catch (err: any) {
      if (err?.code !== 'P2002') {
        logger.debug({ err }, 'Prisma snapshot record skipped for allowance');
      }
    }
  }

  /**
   * Retrieves active spender authorizations for a wallet.
   */
  public async getAuthorizations(walletAddress: string): Promise<SpenderAuthorizationRecord[]> {
    const results: SpenderAuthorizationRecord[] = [];
    try {
      const snapshots = await prisma.sorobanEventSnapshot.findMany({
        where: {
          from: walletAddress,
          eventType: 'spender_allowance',
        },
        orderBy: { ledgerSeq: 'desc' },
        take: 50,
      });

      for (const snap of snapshots) {
        results.push({
          walletAddress: snap.from,
          tokenContractId: snap.contractId,
          spenderAddress: snap.to,
          allowanceAmount: snap.amount,
          isUnlimited: this.isUnlimitedAllowance(snap.amount),
          grantedAtLedger: snap.ledgerSeq,
          liveUntilLedger: 0,
          txHash: snap.txHash || undefined,
          updatedAt: snap.createdAt.toISOString(),
        });
      }
    } catch {
      // If DB error, return cached memory entries
    }

    return results;
  }
}

export const allowanceSentinelService = new AllowanceSentinelService();
