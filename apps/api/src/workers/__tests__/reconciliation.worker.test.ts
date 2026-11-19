import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../modules/analytics/reconciliation.service', () => ({
  runDailyReconciliation: vi.fn(),
}));

vi.mock('../../services/email.service', () => ({
  emailService: { sendRawEmail: vi.fn() },
}));

vi.mock('../../config/env', () => ({
  env: { ADMIN_EMAILS: 'admin1@example.com, admin2@example.com' },
}));

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { runDailyReconciliation } from '../../modules/analytics/reconciliation.service';
import { emailService } from '../../services/email.service';
import { runReconciliationJob } from '../reconciliation.worker';

function cleanReport() {
  return {
    day: '2026-11-10',
    windowStart: '2026-11-10T00:00:00.000Z',
    windowEnd: '2026-11-11T00:00:00.000Z',
    wallets: [
      {
        walletId: 'wallet-1',
        publicKey: 'GPUB1',
        dbCount: 1,
        dbVolume: '100.0000000',
        ledgerCount: 1,
        ledgerVolume: '100.0000000',
        discrepancies: [],
        scanTruncated: false,
      },
    ],
    totalDiscrepancies: 0,
  };
}

function reportWithDiscrepancy() {
  const report = cleanReport();
  report.totalDiscrepancies = 1;
  report.wallets[0].discrepancies = [
    {
      walletId: 'wallet-1',
      publicKey: 'GPUB1',
      kind: 'missing_from_db' as const,
      txHash: 'tx-orphan',
      detail: 'Payment present on ledger but not recorded in DB for this window.',
    },
  ];
  return report;
}

describe('runReconciliationJob', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('sends no email when reconciliation is clean', async () => {
    (runDailyReconciliation as any).mockResolvedValue(cleanReport());

    await runReconciliationJob(new Date('2026-11-10T00:10:00Z'));

    expect(emailService.sendRawEmail).not.toHaveBeenCalled();
  });

  it('emails every configured admin when a discrepancy is found', async () => {
    (runDailyReconciliation as any).mockResolvedValue(reportWithDiscrepancy());

    await runReconciliationJob(new Date('2026-11-10T00:10:00Z'));

    expect(emailService.sendRawEmail).toHaveBeenCalledTimes(2);
    const recipients = (emailService.sendRawEmail as any).mock.calls.map((c: any[]) => c[0].to);
    expect(recipients).toEqual(['admin1@example.com', 'admin2@example.com']);
    const [{ subject, text }] = (emailService.sendRawEmail as any).mock.calls[0];
    expect(subject).toContain('1 ledger reconciliation discrepancy');
    expect(text).toContain('tx-orphan');
  });

  it('does not throw when an individual admin email fails to send', async () => {
    (runDailyReconciliation as any).mockResolvedValue(reportWithDiscrepancy());
    (emailService.sendRawEmail as any).mockRejectedValueOnce(new Error('smtp down'));

    await expect(runReconciliationJob(new Date('2026-11-10T00:10:00Z'))).resolves.toBeDefined();
    expect(emailService.sendRawEmail).toHaveBeenCalledTimes(2);
  });
});
