import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    payment: { findMany: vi.fn() },
    wallet: { findMany: vi.fn() },
  },
}));

vi.mock('../../../lib/stellar', () => ({
  stellar: { getPaymentsSinceResult: vi.fn() },
}));

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { prisma } from '../../../lib/prisma';
import { stellar } from '../../../lib/stellar';
import { reconcileWallet, runDailyReconciliation } from '../reconciliation.service';

const DAY = new Date('2026-11-10T00:00:00.000Z');

function horizonPage(
  records: Array<{ txHash: string; amount: string; createdAt: string; pagingToken: string }>,
) {
  return {
    allNodesFailed: false,
    lastError: null,
    records: records.map((r) => ({
      type: 'payment' as const,
      paging_token: r.pagingToken,
      created_at: r.createdAt,
      transaction_hash: r.txHash,
      amount: r.amount,
      asset_type: 'native',
      from: 'GFROM',
      to: 'GTO',
    })),
  };
}

describe('reconcileWallet', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports zero discrepancies when DB and ledger agree exactly', async () => {
    (prisma.payment.findMany as any).mockResolvedValue([
      { txHash: 'tx1', amount: '100.0000000' },
      { txHash: 'tx2', amount: '50.0000000' },
    ]);
    (stellar.getPaymentsSinceResult as any)
      .mockResolvedValueOnce(
        horizonPage([
          { txHash: 'tx1', amount: '100.0000000', createdAt: '2026-11-10T01:00:00Z', pagingToken: '1' },
          { txHash: 'tx2', amount: '50.0000000', createdAt: '2026-11-10T02:00:00Z', pagingToken: '2' },
        ]),
      )
      .mockResolvedValueOnce(horizonPage([]));

    const result = await reconcileWallet('wallet-1', 'GPUBKEY', DAY);

    expect(result.discrepancies).toEqual([]);
    expect(result.dbCount).toBe(2);
    expect(result.ledgerCount).toBe(2);
  });

  it('flags a payment present in the DB but missing from the ledger', async () => {
    (prisma.payment.findMany as any).mockResolvedValue([{ txHash: 'tx-ghost', amount: '10.0000000' }]);
    (stellar.getPaymentsSinceResult as any).mockResolvedValueOnce(horizonPage([]));

    const result = await reconcileWallet('wallet-1', 'GPUBKEY', DAY);

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({ kind: 'missing_from_ledger', txHash: 'tx-ghost' });
  });

  it('flags a payment present on the ledger but missing from the DB', async () => {
    (prisma.payment.findMany as any).mockResolvedValue([]);
    (stellar.getPaymentsSinceResult as any)
      .mockResolvedValueOnce(
        horizonPage([
          { txHash: 'tx-unrecorded', amount: '25.0000000', createdAt: '2026-11-10T01:00:00Z', pagingToken: '1' },
        ]),
      )
      .mockResolvedValueOnce(horizonPage([]));

    const result = await reconcileWallet('wallet-1', 'GPUBKEY', DAY);

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({ kind: 'missing_from_db', txHash: 'tx-unrecorded' });
  });

  it('flags an amount mismatch between DB and ledger for the same transaction', async () => {
    (prisma.payment.findMany as any).mockResolvedValue([{ txHash: 'tx1', amount: '100.0000000' }]);
    (stellar.getPaymentsSinceResult as any)
      .mockResolvedValueOnce(
        horizonPage([
          { txHash: 'tx1', amount: '999.0000000', createdAt: '2026-11-10T01:00:00Z', pagingToken: '1' },
        ]),
      )
      .mockResolvedValueOnce(horizonPage([]));

    const result = await reconcileWallet('wallet-1', 'GPUBKEY', DAY);

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]).toMatchObject({ kind: 'amount_mismatch', txHash: 'tx1' });
  });

  it('excludes ledger records outside the reconciliation window', async () => {
    (prisma.payment.findMany as any).mockResolvedValue([]);
    (stellar.getPaymentsSinceResult as any)
      .mockResolvedValueOnce(
        horizonPage([
          { txHash: 'tx-before', amount: '1.0000000', createdAt: '2026-11-09T23:00:00Z', pagingToken: '1' },
          { txHash: 'tx-after', amount: '2.0000000', createdAt: '2026-11-11T01:00:00Z', pagingToken: '2' },
        ]),
      )
      .mockResolvedValueOnce(horizonPage([]));

    const result = await reconcileWallet('wallet-1', 'GPUBKEY', DAY);

    expect(result.ledgerCount).toBe(0);
    expect(result.discrepancies).toEqual([]);
  });

  it('throws when every Horizon node fails instead of reporting a false-clean result', async () => {
    (prisma.payment.findMany as any).mockResolvedValue([]);
    (stellar.getPaymentsSinceResult as any).mockResolvedValueOnce({
      allNodesFailed: true,
      lastError: 'all nodes down',
      records: [],
    });

    await expect(reconcileWallet('wallet-1', 'GPUBKEY', DAY)).rejects.toThrow(/Horizon unreachable/);
  });

  it('marks scanTruncated when the page cap is hit before reaching the window', async () => {
    (prisma.payment.findMany as any).mockResolvedValue([]);
    // Every page stays within the window (never crosses windowEnd), so the
    // scan keeps paging until MAX_PAGES_PER_WALLET is exhausted.
    (stellar.getPaymentsSinceResult as any).mockImplementation((_pk: string, cursor: string) =>
      Promise.resolve(
        horizonPage([
          {
            txHash: `tx-${cursor}`,
            amount: '1.0000000',
            createdAt: '2026-11-10T01:00:00Z',
            pagingToken: String(Number(cursor) + 1),
          },
        ]),
      ),
    );

    const result = await reconcileWallet('wallet-1', 'GPUBKEY', DAY);

    expect(result.scanTruncated).toBe(true);
  });
});

describe('runDailyReconciliation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('aggregates discrepancies across all active wallets', async () => {
    (prisma.wallet.findMany as any).mockResolvedValue([
      { id: 'wallet-1', publicKey: 'GPUB1' },
      { id: 'wallet-2', publicKey: 'GPUB2' },
    ]);
    (prisma.payment.findMany as any)
      .mockResolvedValueOnce([{ txHash: 'tx1', amount: '100.0000000' }]) // wallet-1: matches
      .mockResolvedValueOnce([]); // wallet-2: nothing in DB
    (stellar.getPaymentsSinceResult as any)
      .mockResolvedValueOnce(
        horizonPage([
          { txHash: 'tx1', amount: '100.0000000', createdAt: '2026-11-10T01:00:00Z', pagingToken: '1' },
        ]),
      )
      .mockResolvedValueOnce(horizonPage([]))
      .mockResolvedValueOnce(
        horizonPage([
          { txHash: 'tx-orphan', amount: '5.0000000', createdAt: '2026-11-10T01:00:00Z', pagingToken: '1' },
        ]),
      )
      .mockResolvedValueOnce(horizonPage([]));

    const report = await runDailyReconciliation(DAY);

    expect(report.wallets).toHaveLength(2);
    expect(report.totalDiscrepancies).toBe(1);
    expect(report.day).toBe('2026-11-10');
  });

  it('continues reconciling remaining wallets when one wallet fails', async () => {
    (prisma.wallet.findMany as any).mockResolvedValue([
      { id: 'wallet-1', publicKey: 'GPUB1' },
      { id: 'wallet-2', publicKey: 'GPUB2' },
    ]);
    (prisma.payment.findMany as any).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    (stellar.getPaymentsSinceResult as any)
      .mockResolvedValueOnce({ allNodesFailed: true, lastError: 'down', records: [] })
      .mockResolvedValueOnce(horizonPage([]));

    const report = await runDailyReconciliation(DAY);

    expect(report.wallets).toHaveLength(1);
    expect(report.wallets[0].walletId).toBe('wallet-2');
  });
});
