import { describe, it, expect, beforeEach } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import {
  ContractGovernanceSentinel,
  contractGovernanceSentinel,
  GovernanceAlert,
} from '../governance-sentinel.service';
import { inspectContractGovernance } from '../../../workers/watcher.worker';

describe('ContractGovernanceSentinel (#899)', () => {
  let sentinel: ContractGovernanceSentinel;

  beforeEach(() => {
    sentinel = new ContractGovernanceSentinel();
  });

  describe('Contract Code Hash Updates (update_current_contract_wasm)', () => {
    it('detects contract WASM upgrades and extracts old WASM hash, new WASM hash, and caller', () => {
      const rawEvent = {
        contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        txHash: '0xupgrade_tx_123456789',
        ledgerSeq: 12345,
        callerAddress: 'GD5G...CALLER',
        topic: ['update_current_contract_wasm'],
        value: {
          old_wasm_hash: '1111111111111111111111111111111111111111111111111111111111111111',
          new_wasm_hash: '2222222222222222222222222222222222222222222222222222222222222222',
          caller: 'GD5G...CALLER',
        },
      };

      const alert = sentinel.parseGovernanceEvent(rawEvent);

      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('CONTRACT_UPGRADE');
      expect(alert?.severity).toBe('CRITICAL');
      expect(alert?.contractId).toBe('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM');
      expect(alert?.oldWasmHash).toBe('1111111111111111111111111111111111111111111111111111111111111111');
      expect(alert?.newWasmHash).toBe('2222222222222222222222222222222222222222222222222222222222222222');
      expect(alert?.callerAddress).toBe('GD5G...CALLER');
      expect(alert?.txHash).toBe('0xupgrade_tx_123456789');
      expect(alert?.summary).toContain('upgraded WASM bytecode');
    });

    it('parses simulated Soroban contract upgrade event XDR', () => {
      // Build a mocked ContractEvent XDR
      const newWasmBytes = Buffer.from('abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd', 'hex');
      const contractIdBuffer = Buffer.alloc(32, 1);

      const contractEvent = new StellarSdk.xdr.ContractEvent({
        ext: new StellarSdk.xdr.ExtensionPoint(0),
        contractId: contractIdBuffer,
        type: StellarSdk.xdr.ContractEventType.contract(),
        body: new StellarSdk.xdr.ContractEventBody(0, new StellarSdk.xdr.ContractEventV0({
          topics: [
            StellarSdk.xdr.ScVal.scvSymbol('update_current_contract_wasm'),
          ],
          data: StellarSdk.xdr.ScVal.scvBytes(newWasmBytes),
        })),
      });

      const xdrBase64 = contractEvent.toXDR('base64');

      const alert = sentinel.parseGovernanceEvent({
        xdr: xdrBase64,
        txHash: '0xxdr_upgrade_tx',
        callerAddress: 'G_ADMIN_CALLER',
        ledgerSeq: 78910,
        value: {
          oldWasmHash: '0000000000000000000000000000000000000000000000000000000000000000',
        },
      });

      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('CONTRACT_UPGRADE');
      expect(alert?.severity).toBe('CRITICAL');
      expect(alert?.newWasmHash).toBe('abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd');
      expect(alert?.oldWasmHash).toBe('0000000000000000000000000000000000000000000000000000000000000000');
      expect(alert?.callerAddress).toBe('G_ADMIN_CALLER');
    });
  });

  describe('Administrative Authority Transfers (set_admin, transfer_ownership)', () => {
    it('detects admin rotation and identifies previous admin, new admin, and caller', () => {
      const adminEvent = {
        contractId: 'C_DEFI_TREASURY_CONTRACT',
        txHash: '0xadmin_rotation_tx',
        ledgerSeq: 55555,
        topic: ['set_admin'],
        value: {
          old_admin: 'G_OLD_ADMIN_KEY',
          new_admin: 'G_NEW_COMPROMISED_KEY',
          caller: 'G_KEY_ROTATOR',
        },
      };

      const alert = sentinel.parseGovernanceEvent(adminEvent);

      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('ADMIN_AUTHORITY_TRANSFER');
      expect(alert?.severity).toBe('CRITICAL');
      expect(alert?.contractId).toBe('C_DEFI_TREASURY_CONTRACT');
      expect(alert?.oldAdmin).toBe('G_OLD_ADMIN_KEY');
      expect(alert?.newAdmin).toBe('G_NEW_COMPROMISED_KEY');
      expect(alert?.callerAddress).toBe('G_KEY_ROTATOR');
      expect(alert?.summary).toContain('authority transferred');
    });

    it('returns null for unrelated contract topics', () => {
      const transferEvent = {
        contractId: 'C_TOKEN',
        topic: ['transfer', 'G_FROM', 'G_TO'],
        value: { amount: '100' },
      };
      expect(sentinel.parseGovernanceEvent(transferEvent)).toBeNull();
    });
  });

  describe('Out-of-band Critical Alert Dispatch (Webhooks & Telegram)', () => {
    it('dispatches immediate Critical severity alert to subscribed webhooks and Telegram chats', async () => {
      const dispatchedWebhooks: Array<{ url: string; payload: GovernanceAlert }> = [];
      const dispatchedTelegrams: Array<{ chatId: string; message: string }> = [];

      sentinel.subscribeWebhook('https://hooks.slack.com/services/mock');
      sentinel.subscribeTelegram('chat_telegram_98765');

      const alert: GovernanceAlert = {
        type: 'CONTRACT_UPGRADE',
        severity: 'CRITICAL',
        contractId: 'C_PROTOCOL_CORE',
        topic: 'update_current_contract_wasm',
        oldWasmHash: 'old_hash_111',
        newWasmHash: 'new_hash_222',
        callerAddress: 'G_SUSPICIOUS_CALLER',
        txHash: '0xhash999',
        ledgerSeq: 42000,
        summary: 'CRITICAL: WASM upgraded',
        timestamp: new Date().toISOString(),
      };

      const result = await sentinel.dispatchAlert(alert, {
        customWebhookSender: async (url, payload) => {
          dispatchedWebhooks.push({ url, payload });
          return true;
        },
        customTelegramSender: async (chatId, message) => {
          dispatchedTelegrams.push({ chatId, message });
          return true;
        },
      });

      expect(result.webhooksSent).toBe(1);
      expect(result.telegramsSent).toBe(1);
      expect(result.errors).toHaveLength(0);

      expect(dispatchedWebhooks[0].url).toBe('https://hooks.slack.com/services/mock');
      expect(dispatchedWebhooks[0].payload.newWasmHash).toBe('new_hash_222');
      expect(dispatchedTelegrams[0].chatId).toBe('chat_telegram_98765');
      expect(dispatchedTelegrams[0].message).toContain('CRITICAL GOVERNANCE ALERT');
      expect(dispatchedTelegrams[0].message).toContain('G_SUSPICIOUS_CALLER');
    });
  });

  describe('Watcher Worker Integration', () => {
    it('integrates with watcher worker inspectContractGovernance', async () => {
      const result = await inspectContractGovernance({
        contractId: 'C_TREASURY',
        txHash: '0xgov_tx',
        ledgerSeq: 1111,
        topic: ['transfer_ownership'],
        value: {
          previousAdmin: 'G_OLD_OWNER',
          new_admin: 'G_NEW_OWNER',
          caller: 'G_CALLER',
        },
      });

      expect(result).not.toBeNull();
      expect(result?.type).toBe('ADMIN_AUTHORITY_TRANSFER');
      expect(result?.contractId).toBe('C_TREASURY');
    });
  });
});
