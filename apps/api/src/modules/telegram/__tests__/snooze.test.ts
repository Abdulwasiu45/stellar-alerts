import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseDuration,
  formatRemainingDuration,
  snoozeChat,
  resumeChat,
  isChatSnoozed,
  getChatSnoozeStatus,
} from '../commands/snooze';
import { telegramBot } from '../bot';
import { DispatcherWorker } from '../../../workers/dispatcher.worker';
import { fallbackMemoryCache } from '../../../lib/redis';

describe('Telegram Bot Snooze & Silence Commands (#896)', () => {
  const testChatId = '123456789';

  beforeEach(async () => {
    fallbackMemoryCache.clear();
    await resumeChat(testChatId);
  });

  describe('Duration Parser', () => {
    it('parses valid minute durations', () => {
      expect(parseDuration('15m')).toBe(15 * 60);
      expect(parseDuration('30m')).toBe(30 * 60);
      expect(parseDuration('45 mins')).toBe(45 * 60);
      expect(parseDuration('1 minute')).toBe(60);
    });

    it('parses valid hour durations', () => {
      expect(parseDuration('1h')).toBe(3600);
      expect(parseDuration('2h')).toBe(7200);
      expect(parseDuration('24h')).toBe(24 * 3600);
      expect(parseDuration('12 hours')).toBe(12 * 3600);
    });

    it('parses valid day durations', () => {
      expect(parseDuration('1d')).toBe(86400);
      expect(parseDuration('7d')).toBe(7 * 86400);
      expect(parseDuration('3 days')).toBe(3 * 86400);
    });

    it('rejects invalid duration formats and negative/zero values', () => {
      expect(parseDuration('')).toBeNull();
      expect(parseDuration('invalid')).toBeNull();
      expect(parseDuration('0h')).toBeNull();
      expect(parseDuration('-10m')).toBeNull();
      expect(parseDuration('100xyz')).toBeNull();
      expect(parseDuration('10s')).toBeNull(); // Seconds not allowed for snooze granularity
    });

    it('formats remaining seconds into human readable string', () => {
      expect(formatRemainingDuration(60)).toBe('1m');
      expect(formatRemainingDuration(3600)).toBe('1h');
      expect(formatRemainingDuration(3660)).toBe('1h 1m');
      expect(formatRemainingDuration(86400)).toBe('1d');
    });
  });

  describe('Snooze Lifecycle & State', () => {
    it('snoozes a chat and sets active snooze state', async () => {
      expect(await isChatSnoozed(testChatId)).toBe(false);

      const res = await snoozeChat(testChatId, 1800); // 30 minutes
      expect(res.success).toBe(true);
      expect(res.durationSeconds).toBe(1800);

      expect(await isChatSnoozed(testChatId)).toBe(true);
    });

    it('resumes a snoozed chat immediately upon /resume', async () => {
      await snoozeChat(testChatId, 3600);
      expect(await isChatSnoozed(testChatId)).toBe(true);

      await resumeChat(testChatId);
      expect(await isChatSnoozed(testChatId)).toBe(false);
    });

    it('reports accurate status for active vs snoozed chat', async () => {
      // Active state
      const initialStatus = await getChatSnoozeStatus(testChatId);
      expect(initialStatus.isSnoozed).toBe(false);
      expect(initialStatus.message).toContain('Active Listening');

      // Snoozed state
      await snoozeChat(testChatId, 3600);
      const snoozedStatus = await getChatSnoozeStatus(testChatId);
      expect(snoozedStatus.isSnoozed).toBe(true);
      expect(snoozedStatus.remainingSeconds).toBeGreaterThan(0);
      expect(snoozedStatus.message).toContain('Alerts Snoozed');
    });
  });

  describe('TelegramBot Interactive Commands', () => {
    it('handles /snooze 30m command', async () => {
      const reply = await telegramBot.handleMessage(testChatId, '/snooze 30m');
      expect(reply.text).toContain('Notifications paused for <b>30m</b>');
      expect(await isChatSnoozed(testChatId)).toBe(true);
    });

    it('handles /snooze without argument by defaulting to 1 hour', async () => {
      const reply = await telegramBot.handleMessage(testChatId, '/snooze');
      expect(reply.text).toContain('Notifications paused for <b>1 hour</b>');
      expect(await isChatSnoozed(testChatId)).toBe(true);
    });

    it('handles /snooze with invalid format with helpful guidance', async () => {
      const reply = await telegramBot.handleMessage(testChatId, '/snooze badformat');
      expect(reply.text).toContain('Invalid Duration');
      expect(await isChatSnoozed(testChatId)).toBe(false);
    });

    it('handles /silence command for 24-hour maintenance window', async () => {
      const reply = await telegramBot.handleMessage(testChatId, '/silence');
      expect(reply.text).toContain('All alerts are silenced for <b>24 hours</b>');
      expect(await isChatSnoozed(testChatId)).toBe(true);
    });

    it('handles /resume command', async () => {
      await snoozeChat(testChatId, 3600);
      const reply = await telegramBot.handleMessage(testChatId, '/resume');
      expect(reply.text).toContain('Alerts Resumed');
      expect(await isChatSnoozed(testChatId)).toBe(false);
    });

    it('handles /status command', async () => {
      const reply = await telegramBot.handleMessage(testChatId, '/status');
      expect(reply.text).toContain('Active Listening');
    });
  });

  describe('Dispatcher Integration', () => {
    it('skips dispatch when destination Telegram chat is snoozed', async () => {
      const dispatcher = new DispatcherWorker();

      // Snooze chat
      await snoozeChat(testChatId, 3600);

      const jobData = {
        webhookId: 'wh-tg-1',
        url: 'https://example.com/webhook',
        payload: {
          telegramChatId: testChatId,
          text: 'Payment received: 100 XLM',
        },
      };

      const result = await dispatcher.processJob({ data: jobData });
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('telegram_chat_snoozed');
    });
  });
});
