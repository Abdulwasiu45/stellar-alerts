import { prisma } from '../../lib/prisma';
import { dispatchWebhookAndLog } from '../../lib/queue';
import { fetchWithTimeout } from '../../lib/external-request';
import { createLogger } from '../../lib/logger';
import { decryptPersonalField } from '../../utils/privacy';
import { env } from '../../config/env';

const log = createLogger({ module: 'StellarAlertDelivery' });

export function escapeTelegramHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char);
}

/**
 * Delivers a non-payment event to one user: every active webhook (with the
 * usual delivery log and circuit-breaker handling) and Telegram when linked.
 * Failures on one channel never block the others.
 */
export async function deliverUserAlert(
  userId: string,
  webhookPayload: Record<string, unknown>,
  telegramHtml: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      webhooks: { where: { isActive: true }, select: { id: true } },
      notifyPrefs: true,
    },
  });
  if (!user) return;

  for (const webhook of user.webhooks) {
    try {
      await dispatchWebhookAndLog(webhook.id, webhookPayload);
    } catch (err: unknown) {
      log.warn(`Webhook ${webhook.id} dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const prefs = user.notifyPrefs;
  const chatId = prefs?.telegramEnabled ? decryptPersonalField(prefs.telegramChatId) : null;
  if (chatId && env.TELEGRAM_BOT_TOKEN) {
    try {
      await fetchWithTimeout(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: telegramHtml, parse_mode: 'HTML' }),
        },
        env.NOTIFICATION_PROVIDER_TIMEOUT_MS,
        undefined,
        'Telegram',
      );
    } catch (err: unknown) {
      log.warn(`Telegram alert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
