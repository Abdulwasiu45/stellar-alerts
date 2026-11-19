import cron from 'node-cron';
import { runDailyReconciliation, type ReconciliationReport } from '../modules/analytics/reconciliation.service';
import { emailService } from '../services/email.service';
import { env } from '../config/env';
import { createLogger } from '../lib/logger';

const log = createLogger({ module: 'ReconciliationWorker' });

function parseAdminEmails(raw: string): string[] {
  return raw
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email.includes('@'));
}

function renderDiscrepancyEmail(report: ReconciliationReport): { subject: string; text: string } {
  const lines: string[] = [
    `Ledger reconciliation for ${report.day} found ${report.totalDiscrepancies} discrepanc${
      report.totalDiscrepancies === 1 ? 'y' : 'ies'
    } across ${report.wallets.length} wallet(s).`,
    '',
  ];

  for (const wallet of report.wallets) {
    if (wallet.discrepancies.length === 0) continue;
    lines.push(`Wallet ${wallet.walletId} (${wallet.publicKey}):`);
    lines.push(`  DB: ${wallet.dbCount} payments, ${wallet.dbVolume} total`);
    lines.push(`  Ledger: ${wallet.ledgerCount} payments, ${wallet.ledgerVolume} total`);
    if (wallet.scanTruncated) {
      lines.push('  ⚠️  Ledger scan was truncated before reaching the window start — result may be incomplete.');
    }
    for (const d of wallet.discrepancies) {
      lines.push(`  - [${d.kind}] ${d.txHash}: ${d.detail}`);
    }
    lines.push('');
  }

  return {
    subject: `🚨 Stellar Alerts: ${report.totalDiscrepancies} ledger reconciliation discrepanc${
      report.totalDiscrepancies === 1 ? 'y' : 'ies'
    } detected (${report.day})`,
    text: lines.join('\n'),
  };
}

async function notifyAdminsOfDiscrepancies(report: ReconciliationReport): Promise<void> {
  const adminEmails = parseAdminEmails(env.ADMIN_EMAILS);
  if (adminEmails.length === 0) {
    log.warn('Discrepancies detected but ADMIN_EMAILS is empty; no notification sent');
    return;
  }

  const { subject, text } = renderDiscrepancyEmail(report);
  for (const to of adminEmails) {
    try {
      await emailService.sendRawEmail({ to, subject, html: `<pre>${text}</pre>`, text });
    } catch (error) {
      log.error({ to, err: error }, 'Failed to send reconciliation discrepancy alert');
    }
  }
}

/**
 * Audits every active wallet's DB-recorded payments for `day` (UTC,
 * defaulting to yesterday) against the Stellar ledger's own payment
 * history for that wallet, mathematically proving zero drift or raising a
 * high-priority alert when a discrepancy is found.
 */
export async function runReconciliationJob(day: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)): Promise<ReconciliationReport> {
  log.info({ day: day.toISOString().slice(0, 10) }, '🚀 Starting daily financial ledger reconciliation job...');

  const report = await runDailyReconciliation(day);

  if (report.totalDiscrepancies > 0) {
    log.error(
      { day: report.day, totalDiscrepancies: report.totalDiscrepancies },
      '🚨 Reconciliation found discrepancies; notifying admins',
    );
    await notifyAdminsOfDiscrepancies(report);
  } else {
    log.info({ day: report.day, wallets: report.wallets.length }, '✅ Reconciliation clean: zero ledger drift');
  }

  return report;
}

export function scheduleReconciliationJob(): void {
  // 00:00 UTC daily, reconciling the day that just ended.
  cron.schedule('0 0 * * *', () => {
    runReconciliationJob().catch((error) => {
      log.error({ err: error }, 'Unhandled error in scheduled reconciliation job');
    });
  });

  log.info('🕒 Scheduled daily financial ledger reconciliation cron job.');
}

if (require.main === module) {
  scheduleReconciliationJob();
}
