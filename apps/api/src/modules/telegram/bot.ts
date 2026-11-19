import { createLogger } from '../../lib/logger';
import {
  parseDuration,
  snoozeChat,
  resumeChat,
  getChatSnoozeStatus,
  formatRemainingDuration,
} from './commands/snooze';

const logger = createLogger({ module: 'TelegramBot' });

export interface TelegramMessage {
  message_id: number;
  from?: {
    id: number;
    first_name?: string;
    username?: string;
  };
  chat: {
    id: number | string;
    type: string;
  };
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface BotCommandResponse {
  chatId: string;
  text: string;
  parseMode?: 'HTML' | 'Markdown';
}

export class TelegramBot {
  /**
   * Processes an incoming text command from a Telegram user.
   */
  public async handleMessage(
    chatId: string | number,
    text: string,
  ): Promise<BotCommandResponse> {
    const targetChatId = String(chatId);
    const trimmed = (text || '').trim();
    const [command, ...args] = trimmed.split(/\s+/);
    const cmd = command.toLowerCase().split('@')[0]; // Handle /snooze@BotName format

    logger.debug({ chatId: targetChatId, cmd, args }, 'Processing Telegram command');

    switch (cmd) {
      case '/snooze': {
        const durationArg = args.join(' ').trim();
        if (!durationArg) {
          // Default to 1 hour if no duration provided
          const seconds = 3600;
          await snoozeChat(targetChatId, seconds);
          return {
            chatId: targetChatId,
            text: '🔕 <b>Alerts Snoozed</b>\n\nNotifications paused for <b>1 hour</b>.\nSend /resume to re-enable anytime.',
            parseMode: 'HTML',
          };
        }

        const durationSeconds = parseDuration(durationArg);
        if (!durationSeconds) {
          return {
            chatId: targetChatId,
            text:
              '⚠️ <b>Invalid Duration</b>\n\n' +
              'Please specify a valid time format:\n' +
              '• <code>/snooze 15m</code> (15 minutes)\n' +
              '• <code>/snooze 1h</code> (1 hour)\n' +
              '• <code>/snooze 24h</code> (24 hours)\n' +
              '• <code>/snooze 7d</code> (7 days)',
            parseMode: 'HTML',
          };
        }

        await snoozeChat(targetChatId, durationSeconds);
        const formatted = formatRemainingDuration(durationSeconds);
        return {
          chatId: targetChatId,
          text: `🔕 <b>Alerts Snoozed</b>\n\nNotifications paused for <b>${formatted}</b>.\nSend /resume to re-enable anytime.`,
          parseMode: 'HTML',
        };
      }

      case '/silence': {
        // Default silence period: 24 hours maintenance window
        const seconds = 86400;
        await snoozeChat(targetChatId, seconds);
        return {
          chatId: targetChatId,
          text: '🔕 <b>Notifications Silenced</b>\n\nAll alerts are silenced for <b>24 hours</b> (maintenance mode).\nSend /resume to re-enable anytime.',
          parseMode: 'HTML',
        };
      }

      case '/resume': {
        await resumeChat(targetChatId);
        return {
          chatId: targetChatId,
          text: '🔔 <b>Alerts Resumed</b>\n\nNotifications are now active. You will receive real-time alerts for your monitored wallets.',
          parseMode: 'HTML',
        };
      }

      case '/status': {
        const status = await getChatSnoozeStatus(targetChatId);
        return {
          chatId: targetChatId,
          text: status.message,
          parseMode: 'HTML',
        };
      }

      case '/help':
      case '/start': {
        return {
          chatId: targetChatId,
          text:
            '🤖 <b>Stellar Alerts Bot Commands</b>\n\n' +
            '• <code>/status</code> — View alert listening state and active snooze timer\n' +
            '• <code>/snooze &lt;duration&gt;</code> — Pause notifications (e.g., <code>/snooze 30m</code>, <code>/snooze 2h</code>)\n' +
            '• <code>/silence</code> — Silence notifications for 24 hours\n' +
            '• <code>/resume</code> — Un-snooze and resume notifications immediately\n' +
            '• <code>/help</code> — Show this help guide',
          parseMode: 'HTML',
        };
      }

      default: {
        return {
          chatId: targetChatId,
          text: `Unrecognized command <code>${command}</code>. Send /help to view available commands.`,
          parseMode: 'HTML',
        };
      }
    }
  }

  /**
   * Processes a webhook update received from Telegram API.
   */
  public async handleWebhookUpdate(update: TelegramUpdate): Promise<BotCommandResponse | null> {
    if (!update?.message?.chat?.id || !update.message.text) {
      return null;
    }

    const chatId = update.message.chat.id;
    const text = update.message.text;
    return this.handleMessage(chatId, text);
  }
}

export const telegramBot = new TelegramBot();
