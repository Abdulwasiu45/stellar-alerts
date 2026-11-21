import { prisma } from '../../lib/prisma';
import { stellar } from '../../lib/stellar';
import { getHorizonTxHash } from '../../types/horizon';
import { createLogger } from '../../lib/logger';

const log = createLogger({ module: 'ReconciliationService' });

/** Hard cap on Horizon pages scanned per wallet per run, so a wallet with an
 * enormous payment history cannot make a single day's reconciliation run
 * indefinitely. Each page is up to 200 records, so this bounds a single
 * wallet's scan to 100,000 payment operations. */
const MAX_PAGES_PER_WALLET = 500;
const HORIZON_PAGE_SIZE = 200;

export interface WalletDiscrepancy {
  walletId: string;
  publicKey: string;
  kind: 'missing_from_db' | 'missing_from_ledger' | 'amount_mismatch';
  txHash: string;
  detail: string;
}

export interface WalletReconciliationResult {
  walletId: string;
  publicKey: string;
  dbCount: number;
  dbVolume: string;
  ledgerCount: number;
  ledgerVolume: string;
  discrepancies: WalletDiscrepancy[];
  /** True if the ledger scan hit MAX_PAGES_PER_WALLET before reaching the
   * window start, meaning this wallet's result may be incomplete. */
  scanTruncated: boolean;
}

export interface ReconciliationReport {
  day: string; // YYYY-MM-DD (UTC)
  windowStart: string;
  windowEnd: string;
  wallets: WalletReconciliationResult[];
  totalDiscrepancies: number;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function decimalEquals(a: string, b: string, epsilon = 0.0000001): boolean {
  return Math.abs(Number(a) - Number(b)) < epsilon;
}

/**
 * Fetches every Horizon payment operation for `publicKey` whose
 * `created_at` falls within `[windowStart, windowEnd)`, paging forward
 * from the start of the account's payment history.
 *
 * There is no Horizon-side "jump to this timestamp" cursor, and
 * IngestionCursor only retains the *current* live cursor, not a history of
 * where it was at a prior point in time — so a day in a wallet's distant
 * past cannot be seeked to directly. This scans from the beginning instead,
 * stopping once a page's records cross windowEnd. For a wallet with a long
 * payment history this re-reads all of it every run; MAX_PAGES_PER_WALLET
 * bounds the cost and surfaces via `scanTruncated` when it is hit, rather
 * than silently returning a partial, falsely-clean result.
 */
async function fetchLedgerPaymentsInWindow(
  publicKey: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ records: Array<{ txHash: string; amount: string; createdAt: Date }>; truncated: boolean }> {
  const inWindow: Array<{ txHash: string; amount: string; createdAt: Date }> = [];
  let cursor = '0';
  let truncated = false;

  for (let page = 0; page < MAX_PAGES_PER_WALLET; page += 1) {
    const result = await stellar.getPaymentsSinceResult(publicKey, cursor, HORIZON_PAGE_SIZE);
    if (result.allNodesFailed) {
      throw new Error(`Horizon unreachable while reconciling ${publicKey}: ${result.lastError}`);
    }
    if (result.records.length === 0) {
      break;
    }

    let crossedWindowEnd = false;
    for (const record of result.records) {
      const createdAt = new Date(record.created_at);
      if (createdAt >= windowEnd) {
        crossedWindowEnd = true;
        break;
      }
      if (createdAt >= windowStart && record.type === 'payment' && 'amount' in record) {
        inWindow.push({
          txHash: getHorizonTxHash(record),
          amount: record.amount,
          createdAt,
        });
      }
    }

    const lastRecord = result.records[result.records.length - 1] as { paging_token?: string };
    cursor = lastRecord.paging_token ?? cursor;

    if (crossedWindowEnd) {
      return { records: inWindow, truncated: false };
    }

    if (page === MAX_PAGES_PER_WALLET - 1) {
      truncated = true;
    }
  }

  return { records: inWindow, truncated };
}

/**
 * Reconciles one wallet's DB-recorded Payment rows against the Stellar
 * ledger's own record of its payment operations for the given UTC day,
 * comparing both count and volume, and flagging any individual payment
 * present in exactly one of the two sources or recorded with a different
 * amount in each.
 */
export async function reconcileWallet(
  walletId: string,
  publicKey: string,
  day: Date,
): Promise<WalletReconciliationResult> {
  const windowStart = startOfUtcDay(day);
  const windowEnd = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);

  const [dbPayments, ledger] = await Promise.all([
    prisma.payment.findMany({
      where: { walletId, receivedAt: { gte: windowStart, lt: windowEnd } },
      select: { txHash: true, amount: true },
    }),
    fetchLedgerPaymentsInWindow(publicKey, windowStart, windowEnd),
  ]);

  const dbByTxHash = new Map(dbPayments.map((p) => [p.txHash, String(p.amount)]));
  const ledgerByTxHash = new Map(ledger.records.map((r) => [r.txHash, r.amount]));

  const discrepancies: WalletDiscrepancy[] = [];

  for (const [txHash, dbAmount] of dbByTxHash) {
    const ledgerAmount = ledgerByTxHash.get(txHash);
    if (ledgerAmount === undefined) {
      discrepancies.push({
        walletId,
        publicKey,
        kind: 'missing_from_ledger',
        txHash,
        detail: `Payment recorded in DB (amount ${dbAmount}) but not found in Horizon ledger history for this window.`,
      });
    } else if (!decimalEquals(dbAmount, ledgerAmount)) {
      discrepancies.push({
        walletId,
        publicKey,
        kind: 'amount_mismatch',
        txHash,
        detail: `DB amount ${dbAmount} does not match ledger amount ${ledgerAmount}.`,
      });
    }
  }

  for (const [txHash, ledgerAmount] of ledgerByTxHash) {
    if (!dbByTxHash.has(txHash)) {
      discrepancies.push({
        walletId,
        publicKey,
        kind: 'missing_from_db',
        txHash,
        detail: `Payment present on ledger (amount ${ledgerAmount}) but not recorded in DB for this window.`,
      });
    }
  }

  const dbVolume = dbPayments.reduce((sum, p) => sum + Number(p.amount), 0);
  const ledgerVolume = ledger.records.reduce((sum, r) => sum + Number(r.amount), 0);

  return {
    walletId,
    publicKey,
    dbCount: dbPayments.length,
    dbVolume: dbVolume.toFixed(7),
    ledgerCount: ledger.records.length,
    ledgerVolume: ledgerVolume.toFixed(7),
    discrepancies,
    scanTruncated: ledger.truncated,
  };
}

/**
 * Runs the daily reconciliation audit for every active wallet, proving
 * (or disproving) that the DB's recorded payments for `day` exactly match
 * the Stellar ledger's own record of that wallet's payment operations.
 */
export async function runDailyReconciliation(day: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)): Promise<ReconciliationReport> {
  const windowStart = startOfUtcDay(day);
  const windowEnd = new Date(windowStart.getTime() + 24 * 60 * 60 * 1000);

  const wallets = await prisma.wallet.findMany({
    where: { deletedAt: null },
    select: { id: true, publicKey: true },
  });

  const results: WalletReconciliationResult[] = [];
  for (const wallet of wallets) {
    try {
      const result = await reconcileWallet(wallet.id, wallet.publicKey, day);
      results.push(result);
      if (result.discrepancies.length > 0) {
        log.error(
          { walletId: wallet.id, publicKey: wallet.publicKey, discrepancies: result.discrepancies },
          '🚨 Ledger reconciliation discrepancy detected',
        );
      }
      if (result.scanTruncated) {
        log.warn(
          { walletId: wallet.id, publicKey: wallet.publicKey },
          'Reconciliation scan truncated before reaching the window start; result may be incomplete',
        );
      }
    } catch (error) {
      log.error(
        { walletId: wallet.id, publicKey: wallet.publicKey, err: error },
        'Reconciliation failed for wallet',
      );
    }
  }

  const totalDiscrepancies = results.reduce((sum, r) => sum + r.discrepancies.length, 0);

  return {
    day: windowStart.toISOString().slice(0, 10),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    wallets: results,
    totalDiscrepancies,
  };
}
