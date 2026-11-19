import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AllowanceSentinelService,
  allowanceSentinelService,
  MAX_I128,
  MAX_U128,
  MAX_I64,
  EXCESSIVE_ALLOWANCE_THRESHOLD_UNITS,
} from '../allowance-sentinel.service';
import { inspectSorobanApproval } from '../../../workers/watcher.worker';
import { fallbackMemoryCache } from '../../../lib/redis';

describe('AllowanceSentinelService (#901)', () => {
  const service = new AllowanceSentinelService();
  const assetContract = 'dummy-asset-contract-id';
  const ownerAddress = 'GBPDX2DPTESTUSERWALLET1234567890';
  const spenderContract = 'CSPENDER_ROUTER_DEX_CONTRACT_ID';

  beforeEach(() => {
    fallbackMemoryCache.clear();
  });

  describe('Allowance Threshold Detection', () => {
    it('detects unlimited / max integer allowances', () => {
      expect(service.isUnlimitedAllowance(MAX_U128)).toBe(true);
      expect(service.isUnlimitedAllowance(MAX_I128)).toBe(true);
      expect(service.isUnlimitedAllowance(MAX_I64)).toBe(true);
      expect(service.isUnlimitedAllowance(1n << 65n)).toBe(true);

      // Normal values are not unlimited
      expect(service.isUnlimitedAllowance(500n)).toBe(false);
      expect(service.isUnlimitedAllowance(1000000n)).toBe(false);
    });

    it('detects excessive allowance exceeding 10,000,000 units', () => {
      // 15,000,000 units
      expect(service.isExcessiveAllowance(15_000_000n)).toBe(true);
      expect(service.isExcessiveAllowance(10_000_001n)).toBe(true);

      // Under threshold
      expect(service.isExcessiveAllowance(5_000_000n, 0)).toBe(false);
      expect(service.isExcessiveAllowance(100n, 0)).toBe(false);
    });
  });

  describe('SAC Approve Topic & Event Parsing', () => {
    it('parses standard SAC approve event correctly', () => {
      const rawEvent = {
        topic: ['approve', ownerAddress, spenderContract],
        amount: '50000000', // 5 tokens with 7 decimals
        liveUntilLedger: 1250000,
        ledgerSeq: 1200000,
        transaction_hash: '0xhash_approve_1',
      };

      const parsed = service.parseApprovalEvent(rawEvent, assetContract);
      expect(parsed).not.toBeNull();
      expect(parsed?.tokenContractId).toBe(assetContract);
      expect(parsed?.owner).toBe(ownerAddress);
      expect(parsed?.spender).toBe(spenderContract);
      expect(parsed?.rawAmount).toBe(50000000n);
      expect(parsed?.liveUntilLedger).toBe(1250000);
      expect(parsed?.txHash).toBe('0xhash_approve_1');
    });

    it('parses infinite approval event with max u128 amount', () => {
      const rawEvent = {
        topic: ['approve'],
        owner: ownerAddress,
        spender: spenderContract,
        value: {
          amount: MAX_U128.toString(),
          live_until_ledger: 2000000,
        },
        ledger: 100000,
        txHash: '0xhash_infinite_approve',
      };

      const parsed = service.parseApprovalEvent(rawEvent, assetContract);
      expect(parsed).not.toBeNull();
      expect(parsed?.rawAmount).toBe(MAX_U128);
      expect(service.isUnlimitedAllowance(parsed!.rawAmount)).toBe(true);
    });

    it('ignores non-approve events', () => {
      const rawTransfer = {
        topic: ['transfer', ownerAddress, spenderContract],
        amount: '1000',
      };
      expect(service.parseApprovalEvent(rawTransfer, assetContract)).toBeNull();
    });
  });

  describe('Security Alert Generation & Authorization Tracking', () => {
    it('emits critical alert on unlimited token allowance and records authorization', async () => {
      const event = {
        tokenContractId: assetContract,
        owner: ownerAddress,
        spender: spenderContract,
        amount: MAX_U128.toString(),
        rawAmount: MAX_U128,
        liveUntilLedger: 9999999,
        ledgerSeq: 500,
        txHash: '0xtx_unlimited',
      };

      const alert = await service.inspectApproval(event);
      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('UNLIMITED_ALLOWANCE_GRANTED');
      expect(alert?.severity).toBe('CRITICAL');
      expect(alert?.walletAddress).toBe(ownerAddress);
      expect(alert?.tokenContractId).toBe(assetContract);
      expect(alert?.spenderAddress).toBe(spenderContract);
      expect(alert?.isUnlimited).toBe(true);
      expect(alert?.ceilingDescription).toContain('Unlimited');
      expect(alert?.riskRecommendation).toContain('Revoke or reduce allowance');

      // Verify cached record
      const cacheKey = `stellar:allowance:${ownerAddress}:${assetContract}:${spenderContract}`;
      expect(fallbackMemoryCache.exists(cacheKey)).toBe(true);
    });

    it('emits warning alert on excessive allowance (>10,000,000 units)', async () => {
      const event = {
        tokenContractId: assetContract,
        owner: ownerAddress,
        spender: spenderContract,
        amount: '20000000',
        rawAmount: 20000000n,
        liveUntilLedger: 50000,
        ledgerSeq: 1000,
      };

      const alert = await service.inspectApproval(event);
      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('EXCESSIVE_ALLOWANCE_GRANTED');
      expect(alert?.severity).toBe('WARNING');
      expect(alert?.isUnlimited).toBe(false);
      expect(alert?.ceilingDescription).toContain('exceeds 10000000 unit threshold');
    });

    it('does not alert on standard safe allowances', async () => {
      const event = {
        tokenContractId: assetContract,
        owner: ownerAddress,
        spender: spenderContract,
        amount: '1000',
        rawAmount: 1000n,
        liveUntilLedger: 50000,
      };

      const alert = await service.inspectApproval(event);
      expect(alert).toBeNull();
    });

    it('integrates with inspectSorobanApproval in watcher.worker', async () => {
      const rawEvent = {
        topic: ['approve', ownerAddress, spenderContract],
        amount: MAX_I128.toString(),
        liveUntilLedger: 999999,
      };

      const alert = await inspectSorobanApproval(rawEvent, assetContract);
      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('UNLIMITED_ALLOWANCE_GRANTED');
    });
  });
});
