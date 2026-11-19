import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '../lib/prisma';
import { emailService } from '../services/email.service';
import { createLogger } from '../lib/logger';

const logger = createLogger({ module: 'DigestWorker' });

export interface DigestSummary {
  userId: string;
  email: string;
  displayName: string;
  totalPaymentsReceived: number;
  totalVolume: string;
  totalVolumeAsset: string;
  securityAlerts: Array<{ title: string; description: string; occurredAt: string }>;
  windowStart: string;
  windowEnd: string;
}

const DIGEST_TEMPLATE_PATH = join(__dirname, '../modules/notifications/templates/digest.html');
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

const DEFAULT_DIGEST_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
  <body style="font-family:Arial,sans-serif;color:#111827;">
    <h2>Hello {{displayName}},</h2>
    <p>Here is your 24-hour Stellar Alerts summary ({{windowStart}} &ndash; {{windowEnd}}):</p>
    <ul>
      <li><strong>Payments received:</strong> {{totalPaymentsReceived}}</li>
      <li><strong>Total volume:</strong> {{totalVolume}}</li>
    </ul>
    <h3>Delivery &amp; Security Alerts</h3>
    <table style="border-collapse:collapse;width:100%;">{{securityAlertsHtml}}</table>
  </body>
</html>`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAmount(amount: number, asset: string): string {
  if (!Number.isFinite(amount)) {
    return `0.0000000 ${asset}`;
  }
  return `${amount.toFixed(7)} ${asset}`;
}

async function buildUserDigestSummary(
  user: { id: string; email: string; wallets: Array<{ id: string }> },
  windowStart: Date,
  windowEnd: Date,
): Promise<DigestSummary> {
  const walletIds = user.wallets.map((w) => w.id);

  const payments =
    walletIds.length > 0
      ? await prisma.payment.findMany({
          where: {
            walletId: { in: walletIds },
            receivedAt: { gte: windowStart, lte: windowEnd },
          },
          select: { amount: true, asset: true },
        })
      : [];

  const deadLetters = await prisma.deadLetter.findMany({
    where: {
      userId: user.id,
      createdAt: { gte: windowStart, lte: windowEnd },
    },
    select: { channel: true, error: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  const totalsByAsset = new Map<string, { sum: number; count: number }>();
  for (const payment of payments) {
    const asset = payment.asset ?? 'XLM';
    const numeric = Number(payment.amount.toString());
    const entry = totalsByAsset.get(asset) ?? { sum: 0, count: 0 };
    entry.count += 1;
    if (Number.isFinite(numeric)) {
      entry.sum += numeric;
    }
    totalsByAsset.set(asset, entry);
  }

  let primaryAsset = 'XLM';
  let primaryCount = 0;
  let primarySum = 0;
  for (const [asset, stats] of totalsByAsset.entries()) {
    if (stats.count > primaryCount) {
      primaryCount = stats.count;
      primaryAsset = asset;
      primarySum = stats.sum;
    }
  }

  return {
    userId: user.id,
    email: user.email,
    displayName: user.email.split('@')[0],
    totalPaymentsReceived: payments.length,
    totalVolume: formatAmount(primarySum, primaryAsset),
    totalVolumeAsset: primaryAsset,
    securityAlerts: deadLetters.map((dl) => ({
      title: `Delivery failure (${dl.channel})`,
      description: dl.error,
      occurredAt: dl.createdAt.toISOString(),
    })),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
}

export async function compileDigestSummaries(
  windowStart: Date,
  windowEnd: Date,
): Promise<DigestSummary[]> {
  const users = await prisma.user.findMany({
    where: {
      notifyPrefs: { is: { emailEnabled: true } },
    },
    select: {
      id: true,
      email: true,
      wallets: {
        where: { deletedAt: null },
        select: { id: true },
      },
    },
  });

  const summaries: DigestSummary[] = [];
  for (const user of users) {
    summaries.push(await buildUserDigestSummary(user, windowStart, windowEnd));
  }
  return summaries;
}

export function renderDigestHtml(summary: DigestSummary): string {
  const template = existsSync(DIGEST_TEMPLATE_PATH)
    ? readFileSync(DIGEST_TEMPLATE_PATH, 'utf-8')
    : DEFAULT_DIGEST_HTML_TEMPLATE;

  const alertsHtml =
    summary.securityAlerts.length > 0
      ? summary.securityAlerts
          .map(
            (alert) =>
              `<tr><td style="padding:12px;border-bottom:1px solid #eee;"><strong>${escapeHtml(alert.title)}</strong><br/><span style="color:#555;font-size:13px;">${escapeHtml(alert.description)}</span><br/><span style="color:#999;font-size:12px;">${escapeHtml(alert.occurredAt)}</span></td></tr>`,
          )
          .join('')
      : `<tr><td style="padding:12px;color:#555;">No alerts in the past 24 hours.</td></tr>`;

  const replacements: Record<string, string> = {
    '{{displayName}}': escapeHtml(summary.displayName),
    '{{totalPaymentsReceived}}': String(summary.totalPaymentsReceived),
    '{{totalVolume}}': escapeHtml(summary.totalVolume),
    '{{securityAlertsHtml}}': alertsHtml,
    '{{windowStart}}': escapeHtml(summary.windowStart),
    '{{windowEnd}}': escapeHtml(summary.windowEnd),
  };

  let html = template;
  for (const [token, value] of Object.entries(replacements)) {
    html = html.split(token).join(value);
  }
  return html;
}

export async function runDigestWorker(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const windowEnd = new Date(now);
  const windowStart = new Date(windowEnd.getTime() - TWENTY_FOUR_HOURS_MS);

  const summaries = await compileDigestSummaries(windowStart, windowEnd);

  let sent = 0;
  let failed = 0;

  for (const summary of summaries) {
    try {
      const html = renderDigestHtml(summary);
      await emailService.sendRawEmail({
        to: summary.email,
        subject: 'Your 24-hour Stellar Alerts digest',
        html,
        text: `Payments received: ${summary.totalPaymentsReceived}\nTotal volume: ${summary.totalVolume}\nAlerts: ${summary.securityAlerts.length}`,
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      logger.error(
        {
          userId: summary.userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'DigestWorker failed to send digest',
      );
    }
  }

  logger.info({ sent, failed, windowStart, windowEnd }, 'DigestWorker completed');
  return { sent, failed };
}

export const digestWorker = {
  name: 'DigestWorker',
  cron: '0 0 0 * * *',
  async run(): Promise<void> {
    await runDigestWorker();
  },
  async processUser(
    userId: string,
    prefs: { emailEnabled?: boolean },
    options: { force?: boolean } = {},
  ): Promise<{ sent: boolean; reason?: string }> {
    if (!prefs?.emailEnabled && !options.force) {
      return { sent: false, reason: 'email_disabled' };
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        wallets: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });
    if (!user) {
      return { sent: false, reason: 'user_not_found' };
    }

    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - TWENTY_FOUR_HOURS_MS);
    const summary = await buildUserDigestSummary(user, windowStart, windowEnd);
    const html = renderDigestHtml(summary);
    await emailService.sendRawEmail({
      to: summary.email,
      subject: 'Your 24-hour Stellar Alerts digest',
      html,
      text: `Payments received: ${summary.totalPaymentsReceived}\nTotal volume: ${summary.totalVolume}\nAlerts: ${summary.securityAlerts.length}`,
    });
    return { sent: true };
  },
};

export default digestWorker;
