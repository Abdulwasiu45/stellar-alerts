import { redis, fallbackMemoryCache, isRedisDegraded } from '../../../lib/redis';
import { createLogger } from '../../../lib/logger';

const logger = createLogger({ module: 'TelegramSnoozeCommand' });

export const SNOOZE_KEY_PREFIX = 'telegram:snooze:';

export function getSnoozeRedisKey(chatId: string): string {
  return `${SNOOZE_KEY_PREFIX}${chatId.trim()}`;
}

/**
 * Parses duration strings into seconds.
 * Supported units:
 * - m / min / mins / minutes (e.g., "15m", "30 mins")
 * - h / hr / hrs / hours (e.g., "1h", "24 hours")
 * - d / day / days (e.g., "1d", "7 days")
 * Returns null for invalid formats.
 */
export function parseDuration(input: string): number | null {
  if (!input || typeof input !== 'string') return null;

  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  if (isNaN(value) || value <= 0) return null;

  const unit = match[2];
  if (unit.startsWith('m')) {
    return value * 60;
  }
  if (unit.startsWith('h')) {
    return value * 3600;
  }
  if (unit.startsWith('d')) {
    return value * 86400;
  }

  return null;
}

/**
 * Formats a duration in seconds into human-readable text (e.g. "2h 30m" or "45m").
 */
export function formatRemainingDuration(seconds: number): string {
  if (seconds <= 0) return '0s';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 && parts.length === 0) parts.push(`${secs}s`);

  return parts.join(' ') || '0s';
}

/**
 * Snoozes alerts for the given Telegram chat ID for a specified duration in seconds.
 */
export async function snoozeChat(
  chatId: string,
  durationSeconds: number,
): Promise<{ success: boolean; expiresAt: Date; durationSeconds: number }> {
  const key = getSnoozeRedisKey(chatId);
  const expiresAt = new Date(Date.now() + durationSeconds * 1000);
  const payload = JSON.stringify({ chatId, expiresAt: expiresAt.toISOString(), durationSeconds });

  fallbackMemoryCache.set(key, payload, durationSeconds);

  try {
    if (!isRedisDegraded()) {
      await redis.set(key, payload, 'EX', durationSeconds);
    }
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to persist snooze key in Redis, used memory fallback');
  }

  logger.info(`Snoozed notifications for Telegram chat ${chatId} for ${durationSeconds}s (until ${expiresAt.toISOString()})`);
  return { success: true, expiresAt, durationSeconds };
}

/**
 * Resumes alerts for the given Telegram chat ID by clearing the snooze key.
 */
export async function resumeChat(chatId: string): Promise<boolean> {
  const key = getSnoozeRedisKey(chatId);
  fallbackMemoryCache.del(key);

  try {
    if (!isRedisDegraded()) {
      await redis.del(key);
    }
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to delete snooze key from Redis');
  }

  logger.info(`Resumed notifications for Telegram chat ${chatId}`);
  return true;
}

/**
 * Checks whether a given Telegram chat is currently snoozed.
 */
export async function isChatSnoozed(chatId: string | null | undefined): Promise<boolean> {
  if (!chatId) return false;
  const key = getSnoozeRedisKey(chatId);

  // Check fallback memory first for immediate local hit
  if (fallbackMemoryCache.exists(key)) {
    return true;
  }

  try {
    if (!isRedisDegraded()) {
      const exists = await redis.exists(key);
      return exists === 1;
    }
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed checking Redis snooze key');
  }

  return false;
}

export interface ChatSnoozeStatus {
  isSnoozed: boolean;
  remainingSeconds: number;
  formattedRemaining?: string;
  message: string;
}

/**
 * Retrieves the current snooze status and remaining time for a chat.
 */
export async function getChatSnoozeStatus(chatId: string): Promise<ChatSnoozeStatus> {
  const key = getSnoozeRedisKey(chatId);
  let remainingSeconds = 0;

  try {
    if (!isRedisDegraded()) {
      const ttl = await redis.ttl(key);
      if (ttl > 0) {
        remainingSeconds = ttl;
      }
    }
  } catch {
    // Fall back to memory cache check
  }

  if (remainingSeconds <= 0) {
    const raw = fallbackMemoryCache.get(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const exp = new Date(parsed.expiresAt).getTime();
        const diff = Math.floor((exp - Date.now()) / 1000);
        if (diff > 0) remainingSeconds = diff;
      } catch {
        // Ignore
      }
    }
  }

  if (remainingSeconds > 0) {
    const formatted = formatRemainingDuration(remainingSeconds);
    return {
      isSnoozed: true,
      remainingSeconds,
      formattedRemaining: formatted,
      message: `🔕 <b>Alerts Snoozed</b>\n\nNotifications are paused for this chat.\nRemaining time: <b>${formatted}</b>\n\nSend /resume to turn notifications back on immediately.`,
    };
  }

  return {
    isSnoozed: false,
    remainingSeconds: 0,
    message: '🔔 <b>Active Listening</b>\n\nNotifications are currently active and un-snoozed for this chat.\n\nUse <code>/snooze 1h</code> or <code>/silence</code> to mute temporarily.',
  };
}
