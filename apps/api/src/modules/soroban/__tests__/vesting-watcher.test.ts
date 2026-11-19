import { describe, it, expect, beforeEach } from 'vitest';
import { VestingWatcherService, vestingWatcherService } from '../vesting-watcher.service';
import { VestingSchedule } from '@stellar-alerts/shared';
import { executeVestingCheckPass } from '../../../workers/vesting.worker';
import { fallbackMemoryCache } from '../../../lib/redis';

describe('VestingWatcherService (#902)', () => {
  const service = new VestingWatcherService();
  const contractId = 'CVESTING_CONTRACT_TEST_123';
  const beneficiary = 'GBENEFICIARY_WALLET_ADDR';
  const tokenAddress = 'CTOKEN_SAC_USDC';

  beforeEach(() => {
    fallbackMemoryCache.clear();
  });

  describe('Unlock Calculation Across Cliff & Linear Vesting Curves', () => {
    const baseSchedule: VestingSchedule = {
      contractId,
      beneficiary,
      tokenAddress,
      totalAmount: '120000', // 120,000 tokens
      startTime: 1000,
      duration: 1000, // Duration: 1,000 seconds
      cliffDuration: 200, // 200 second cliff
      revocable: true,
      clawbackEnabled: true,
      tranches: [],
    };

    it('returns 0 vested tokens before cliff duration is met', () => {
      // At t = 1100 (100 seconds after start, before cliff at 1200)
      const state = service.calculateVestedAmount(baseSchedule, 1100);
      expect(state.vestedAmount).toBe(0n);
      expect(state.unvestedAmount).toBe(120000n);
      expect(state.isCliffMet).toBe(false);
      expect(state.progressPercent).toBe(0);
    });

    it('calculates linear vested amount proportionally after cliff is passed', () => {
      // At t = 1500 (500 seconds elapsed out of 1000 => 50% vested)
      const state = service.calculateVestedAmount(baseSchedule, 1500);
      expect(state.vestedAmount).toBe(60000n);
      expect(state.unvestedAmount).toBe(60000n);
      expect(state.isCliffMet).toBe(true);
      expect(state.progressPercent).toBe(50);
    });

    it('returns 100% vested amount once schedule duration completes', () => {
      // At t = 2000 or greater
      const state = service.calculateVestedAmount(baseSchedule, 2500);
      expect(state.vestedAmount).toBe(120000n);
      expect(state.unvestedAmount).toBe(0n);
      expect(state.isCliffMet).toBe(true);
      expect(state.progressPercent).toBe(100);
    });
  });

  describe('Milestone Maturity & Pre-Unlock Alerts', () => {
    it('emits pre-maturity alert 24 hours prior to tranche maturity', async () => {
      const now = 100000;
      const unlockTime = now + 43200; // 12 hours from now (<24 hours)

      const schedule: VestingSchedule = {
        contractId,
        beneficiary,
        tokenAddress,
        totalAmount: '50000',
        startTime: now - 10000,
        duration: 53200,
        cliffDuration: 0,
        revocable: false,
        clawbackEnabled: false,
        tranches: [
          {
            index: 1,
            unlockTimestamp: unlockTime,
            amount: '50000',
            percent: 100,
            isUnlocked: false,
          },
        ],
      };

      const alerts = await service.evaluateScheduleAlerts(schedule, now);
      expect(alerts.length).toBe(1);
      expect(alerts[0].alertType).toBe('PRE_MATURITY_24H');
      expect(alerts[0].severity).toBe('INFO');
      expect(alerts[0].contractId).toBe(contractId);
      expect(alerts[0].beneficiary).toBe(beneficiary);
      expect(alerts[0].message).toContain('matures in ~12 hour(s)');
    });

    it('emits unlock alert immediately upon tranche maturity', async () => {
      const now = 200000;
      const unlockTime = now - 60; // Just unlocked 1 minute ago

      const schedule: VestingSchedule = {
        contractId,
        beneficiary,
        tokenAddress,
        totalAmount: '50000',
        startTime: now - 100000,
        duration: 100000,
        cliffDuration: 0,
        revocable: false,
        clawbackEnabled: false,
        tranches: [
          {
            index: 1,
            unlockTimestamp: unlockTime,
            amount: '50000',
            percent: 100,
            isUnlocked: false,
          },
        ],
      };

      const alerts = await service.evaluateScheduleAlerts(schedule, now);
      expect(alerts.length).toBe(1);
      expect(alerts[0].alertType).toBe('TRANCHE_UNLOCKED');
      expect(alerts[0].severity).toBe('INFO');
      expect(alerts[0].message).toContain('is now UNLOCKED');
    });
  });

  describe('Administrative Clawback & Cancellation Events', () => {
    it('flags administrative clawback event instantly with critical alert', () => {
      const alert = service.handleClawbackEvent(
        contractId,
        beneficiary,
        '25000',
        tokenAddress,
        'Employee termination clawback clause',
      );

      expect(alert.alertType).toBe('CLAWBACK_TRIGGERED');
      expect(alert.severity).toBe('CRITICAL');
      expect(alert.amount).toBe('25000');
      expect(alert.message).toContain('Immediate clawback executed');
      expect(alert.message).toContain('Employee termination clawback clause');
    });

    it('flags schedule cancellation event instantly with critical alert', () => {
      const alert = service.handleCancellationEvent(
        contractId,
        beneficiary,
        tokenAddress,
        'Treasury DAO vote cancelled allocation',
      );

      expect(alert.alertType).toBe('VESTING_CANCELLED');
      expect(alert.severity).toBe('CRITICAL');
      expect(alert.message).toContain('Schedule cancelled');
      expect(alert.message).toContain('Treasury DAO vote');
    });
  });

  describe('Storage Decoding & Worker Check Pass', () => {
    it('decodes raw contract instance storage entry into typed schedule', () => {
      const rawStorage = {
        start_time: 1700000000,
        duration: 31536000,
        cliff_duration: 7776000,
        beneficiary: beneficiary,
        token: tokenAddress,
        total_amount: '500000',
        revocable: true,
      };

      const parsed = service.readContractVestingStorage(contractId, rawStorage);
      expect(parsed).not.toBeNull();
      expect(parsed?.startTime).toBe(1700000000);
      expect(parsed?.cliffDuration).toBe(7776000);
      expect(parsed?.beneficiary).toBe(beneficiary);
      expect(parsed?.totalAmount).toBe('500000');
    });

    it('executes vesting worker check pass successfully', async () => {
      const mockLoader = async () => [
        {
          contractId,
          beneficiary,
          tokenAddress,
          totalAmount: '100000',
          startTime: 1000,
          duration: 50000,
          cliffDuration: 10000,
          revocable: false,
          clawbackEnabled: false,
          tranches: [],
        },
      ];

      const alerts = await executeVestingCheckPass(mockLoader);
      expect(Array.isArray(alerts)).toBe(true);
    });
  });
});
