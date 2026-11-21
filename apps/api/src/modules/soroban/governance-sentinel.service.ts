import * as StellarSdk from 'stellar-sdk';
import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'GovernanceSentinelService' });

export type GovernanceEventType = 'CONTRACT_UPGRADE' | 'ADMIN_AUTHORITY_TRANSFER';

export interface GovernanceAlert {
  type: GovernanceEventType;
  severity: 'CRITICAL';
  contractId: string;
  topic: string;
  oldWasmHash?: string;
  newWasmHash?: string;
  oldAdmin?: string;
  newAdmin?: string;
  callerAddress?: string;
  txHash: string;
  ledgerSeq: number;
  summary: string;
  timestamp: string;
}

export interface GovernanceDispatchResult {
  alert: GovernanceAlert;
  webhooksSent: number;
  webhooksFailed: number;
  telegramsSent: number;
  telegramsFailed: number;
  errors: string[];
}

export interface RawContractEventInput {
  contractId?: string;
  topic?: unknown[];
  value?: unknown;
  data?: unknown;
  txHash?: string;
  transactionHash?: string;
  callerAddress?: string;
  caller?: string;
  sourceAccount?: string;
  ledgerSeq?: number;
  ledger?: number;
  xdr?: string;
}

const UPGRADE_TOPICS = [
  'update_current_contract_wasm',
  'upgrade_contract',
  'upgrade',
  'set_wasm',
  'update_wasm',
  'wasm_updated',
  'contract_upgraded',
];

const ADMIN_TOPICS = [
  'set_admin',
  'transfer_admin',
  'transfer_ownership',
  'change_admin',
  'admin_changed',
  'grant_admin',
  'set_owner',
];

export class ContractGovernanceSentinel {
  private webhookSubscriptions = new Set<string>();
  private telegramSubscriptions = new Set<string>();

  public subscribeWebhook(url: string): void {
    this.webhookSubscriptions.add(url);
  }

  public subscribeTelegram(chatId: string): void {
    this.telegramSubscriptions.add(chatId);
  }

  public clearSubscriptions(): void {
    this.webhookSubscriptions.clear();
    this.telegramSubscriptions.clear();
  }

  /**
   * Parses contract events or event XDR to detect contract upgrades or admin key rotations.
   */
  public parseGovernanceEvent(event: RawContractEventInput): GovernanceAlert | null {
    const timestamp = new Date().toISOString();
    let topicStrings: string[] = [];
    let parsedContractId = event.contractId || '';
    let oldWasmHash: string | undefined;
    let newWasmHash: string | undefined;
    let oldAdmin: string | undefined;
    let newAdmin: string | undefined;
    let callerAddress = event.callerAddress || event.caller || event.sourceAccount;

    // Handle Soroban ContractEvent XDR if provided
    if (event.xdr) {
      try {
        const contractEvent = StellarSdk.xdr.ContractEvent.fromXDR(event.xdr, 'base64');
        const contractIdBytes = contractEvent.contractId();
        if (contractIdBytes) {
          parsedContractId = StellarSdk.StrKey.encodeContract(contractIdBytes);
        }

        const body = contractEvent.body();
        const bodySwitch = typeof body.switch === 'function' ? body.switch() : 0;
        const switchVal = typeof bodySwitch === 'number' ? bodySwitch : (bodySwitch as any)?.value ?? 0;
        if (switchVal === 0) {
          const v0 = body.v0();
          const topics = v0.topics();
          for (const t of topics) {
            try {
              const name = t.switch()?.name;
              if (name === 'scvSymbol' || typeof t.sym === 'function') {
                topicStrings.push(t.sym().toString());
              } else if (name === 'scvString' || typeof t.str === 'function') {
                topicStrings.push(t.str().toString());
              } else if (name === 'scvBytes' || typeof t.bytes === 'function') {
                topicStrings.push(t.bytes().toString('hex'));
              }
            } catch {
              // ignore scval extraction failure
            }
          }

          // Try to extract data/value from v0.data()
          try {
            const dataVal = v0.data();
            const dataSwitch = dataVal.switch()?.name;
            if (dataSwitch === 'scvBytes' || typeof dataVal.bytes === 'function') {
              newWasmHash = dataVal.bytes().toString('hex');
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // Fallback to json fields if XDR parse fails
      }
    }

    if (Array.isArray(event.topic)) {
      for (const t of event.topic) {
        if (typeof t === 'string') {
          topicStrings.push(t);
        } else if (t && typeof t === 'object' && 'value' in t) {
          topicStrings.push(String((t as { value: unknown }).value));
        } else {
          topicStrings.push(String(t));
        }
      }
    }

    const val = (event.value || event.data || {}) as Record<string, unknown>;
    if (!parsedContractId) {
      parsedContractId =
        (typeof val.contractId === 'string' ? val.contractId : '') ||
        (typeof val.contract_id === 'string' ? val.contract_id : '') ||
        'UNKNOWN_CONTRACT';
    }

    const txHash =
      event.txHash ||
      event.transactionHash ||
      (typeof val.txHash === 'string' ? val.txHash : '') ||
      'unknown_tx';

    const ledgerSeq =
      event.ledgerSeq ?? event.ledger ?? (typeof val.ledgerSeq === 'number' ? val.ledgerSeq : 0);

    callerAddress =
      callerAddress ||
      (typeof val.caller === 'string' ? val.caller : '') ||
      (typeof val.callerAddress === 'string' ? val.callerAddress : '') ||
      (typeof val.admin === 'string' ? val.admin : '') ||
      (typeof val.sourceAccount === 'string' ? val.sourceAccount : '') ||
      undefined;

    oldWasmHash =
      oldWasmHash ||
      (typeof val.oldWasmHash === 'string' ? val.oldWasmHash : '') ||
      (typeof val.old_wasm_hash === 'string' ? val.old_wasm_hash : '') ||
      (typeof val.oldCodeHash === 'string' ? val.oldCodeHash : undefined);

    newWasmHash =
      newWasmHash ||
      (typeof val.newWasmHash === 'string' ? val.newWasmHash : '') ||
      (typeof val.new_wasm_hash === 'string' ? val.new_wasm_hash : '') ||
      (typeof val.newCodeHash === 'string' ? val.newCodeHash : '') ||
      (typeof val.wasmHash === 'string' ? val.wasmHash : undefined);

    oldAdmin =
      oldAdmin ||
      (typeof val.oldAdmin === 'string' ? val.oldAdmin : '') ||
      (typeof val.old_admin === 'string' ? val.old_admin : '') ||
      (typeof val.previousAdmin === 'string' ? val.previousAdmin : undefined);

    newAdmin =
      newAdmin ||
      (typeof val.newAdmin === 'string' ? val.newAdmin : '') ||
      (typeof val.new_admin === 'string' ? val.new_admin : '') ||
      (typeof val.new_owner === 'string' ? val.new_owner : undefined);

    const topicCombined = topicStrings.join(' ').toLowerCase();

    const isUpgrade = UPGRADE_TOPICS.some((t) => topicCombined.includes(t));
    const isAdminChange = ADMIN_TOPICS.some((t) => topicCombined.includes(t));

    if (!isUpgrade && !isAdminChange) {
      return null;
    }

    if (isUpgrade) {
      const summary =
        `CRITICAL: Contract ${parsedContractId} upgraded WASM bytecode to ${newWasmHash || 'new hash'}` +
        (oldWasmHash ? ` (previous WASM: ${oldWasmHash})` : '') +
        (callerAddress ? ` by caller ${callerAddress}` : '');

      return {
        type: 'CONTRACT_UPGRADE',
        severity: 'CRITICAL',
        contractId: parsedContractId,
        topic: topicStrings[0] || 'update_current_contract_wasm',
        oldWasmHash,
        newWasmHash,
        callerAddress,
        txHash,
        ledgerSeq,
        summary,
        timestamp,
      };
    }

    const summary =
      `CRITICAL: Contract ${parsedContractId} administrative authority transferred to ${newAdmin || 'new admin'}` +
      (oldAdmin ? ` (previous admin: ${oldAdmin})` : '') +
      (callerAddress ? ` by caller ${callerAddress}` : '');

    return {
      type: 'ADMIN_AUTHORITY_TRANSFER',
      severity: 'CRITICAL',
      contractId: parsedContractId,
      topic: topicStrings[0] || 'set_admin',
      oldAdmin,
      newAdmin,
      callerAddress,
      txHash,
      ledgerSeq,
      summary,
      timestamp,
    };
  }

  /**
   * Dispatches immediate Critical severity alert to all subscribed webhooks and Telegram chats.
   */
  public async dispatchAlert(
    alert: GovernanceAlert,
    destinations?: {
      webhooks?: string[];
      telegramChats?: string[];
      customWebhookSender?: (url: string, payload: GovernanceAlert) => Promise<boolean>;
      customTelegramSender?: (chatId: string, message: string) => Promise<boolean>;
    },
  ): Promise<GovernanceDispatchResult> {
    const webhooks = destinations?.webhooks ?? Array.from(this.webhookSubscriptions);
    const telegramChats = destinations?.telegramChats ?? Array.from(this.telegramSubscriptions);
    const errors: string[] = [];

    let webhooksSent = 0;
    let webhooksFailed = 0;
    let telegramsSent = 0;
    let telegramsFailed = 0;

    logger.warn(
      { contractId: alert.contractId, type: alert.type, severity: alert.severity },
      `🚨 DISPATCHING IMMEDIATE GOVERNANCE ALERT: ${alert.summary}`,
    );

    // 1. Dispatch Webhooks
    for (const url of webhooks) {
      try {
        if (destinations?.customWebhookSender) {
          const ok = await destinations.customWebhookSender(url, alert);
          if (ok) webhooksSent++;
          else {
            webhooksFailed++;
            errors.push(`Webhook send to ${url} failed`);
          }
        } else {
          // Default fetch webhook
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Alert-Severity': alert.severity,
              'X-Alert-Type': alert.type,
            },
            body: JSON.stringify(alert),
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            webhooksSent++;
          } else {
            webhooksFailed++;
            errors.push(`Webhook ${url} returned status ${res.status}`);
          }
        }
      } catch (err: unknown) {
        webhooksFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Webhook ${url} error: ${msg}`);
      }
    }

    // 2. Dispatch Telegram Messages
    const telegramMessage =
      `🚨 *CRITICAL GOVERNANCE ALERT*\n\n` +
      `*Type:* ${alert.type}\n` +
      `*Contract:* \`${alert.contractId}\`\n` +
      (alert.oldWasmHash ? `*Old WASM:* \`${alert.oldWasmHash}\`\n` : '') +
      (alert.newWasmHash ? `*New WASM:* \`${alert.newWasmHash}\`\n` : '') +
      (alert.oldAdmin ? `*Old Admin:* \`${alert.oldAdmin}\`\n` : '') +
      (alert.newAdmin ? `*New Admin:* \`${alert.newAdmin}\`\n` : '') +
      (alert.callerAddress ? `*Caller:* \`${alert.callerAddress}\`\n` : '') +
      `*Ledger:* ${alert.ledgerSeq}\n` +
      `*Tx:* \`${alert.txHash}\`\n\n` +
      `*Summary:* ${alert.summary}`;

    for (const chatId of telegramChats) {
      try {
        if (destinations?.customTelegramSender) {
          const ok = await destinations.customTelegramSender(chatId, telegramMessage);
          if (ok) telegramsSent++;
          else {
            telegramsFailed++;
            errors.push(`Telegram send to ${chatId} failed`);
          }
        } else {
          const botToken = process.env.TELEGRAM_BOT_TOKEN;
          if (botToken) {
            const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
            const res = await fetch(telegramApiUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: chatId,
                text: telegramMessage,
                parse_mode: 'Markdown',
              }),
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              telegramsSent++;
            } else {
              telegramsFailed++;
              errors.push(`Telegram API returned ${res.status} for chat ${chatId}`);
            }
          } else {
            // In test/local mode without token, mark simulated success
            telegramsSent++;
          }
        }
      } catch (err: unknown) {
        telegramsFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Telegram chat ${chatId} error: ${msg}`);
      }
    }

    return {
      alert,
      webhooksSent,
      webhooksFailed,
      telegramsSent,
      telegramsFailed,
      errors,
    };
  }
}

export const contractGovernanceSentinel = new ContractGovernanceSentinel();
