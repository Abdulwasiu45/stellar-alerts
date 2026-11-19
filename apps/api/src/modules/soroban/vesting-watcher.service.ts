import { VestingSchedule, VestingTranche, VestingAlert } from '@stellar-alerts/shared';
import { redis, fallbackMemoryCache, isRedisDegraded } from '../../lib/redis';
import { createLogger } from '../../lib/logger';

const logger = createLogger({ module: 'VestingWatcherService' });

const TWENTY_FOUR_HOURS_SECONDS = 86400;

export class VestingWatcherService {
  /**
   * Calculates unlocked / vested token amount against cliff and linear vesting curves.
   */
  public calculateVestedAmount(
    schedule: VestingSchedule,
    currentTimestampSeconds: number,
  ): {
    vestedAmount: bigint;
    unvestedAmount: bigint;
    isCliffMet: boolean;
    progressPercent: number;
  } {
    const total = BigInt(schedule.totalAmount);
    const cliffEnd = schedule.startTime + schedule.cliffDuration;
    const vestEnd = schedule.startTime + schedule.duration;

    if (currentTimestampSeconds < cliffEnd) {
      return {
        vestedAmount: 0n,
        unvestedAmount: total,
        isCliffMet: false,
        progressPercent: 0,
      };
    }

    if (currentTimestampSeconds >= vestEnd) {
      return {
        vestedAmount: total,
        unvestedAmount: 0n,
        isCliffMet: true,
        progressPercent: 100,
      };
    }

    const elapsed = BigInt(currentTimestampSeconds - schedule.startTime);
    const totalDuration = BigInt(schedule.duration);
    const vestedAmount = (total * elapsed) / totalDuration;
    const unvestedAmount = total - vestedAmount;
    const progressPercent = Math.round(Number((elapsed * 10000n) / totalDuration)) / 100;

    return {
      vestedAmount,
      unvestedAmount,
      isCliffMet: true,
      progressPercent,
    };
  }

  /**
   * Evaluates a vesting schedule against current ledger timestamp:
   * - Emits alert 24 hours prior to tranche maturity.
   * - Emits alert immediately upon tranche unlock.
   */
  public async evaluateScheduleAlerts(
    schedule: VestingSchedule,
    currentTimestampSeconds: number = Math.floor(Date.now() / 1000),
  ): Promise<VestingAlert[]> {
    const alerts: VestingAlert[] = [];
    const tranches = schedule.tranches && schedule.tranches.length > 0
      ? schedule.tranches
      : this.deriveDefaultTranches(schedule);

    for (const tranche of tranches) {
      const unlockTime = tranche.unlockTimestamp;
      const timeRemaining = unlockTime - currentTimestampSeconds;

      // 1. 24 Hours Prior to Tranche Maturity Alert
      if (timeRemaining > 0 && timeRemaining <= TWENTY_FOUR_HOURS_SECONDS) {
        const alertKey = `vesting:pre_alert:${schedule.contractId}:${tranche.index}`;
        const alreadyAlerted = await this.hasAlertBeenSent(alertKey);

        if (!alreadyAlerted) {
          const hoursRemaining = Math.max(1, Math.round(timeRemaining / 3600));
          const alert: VestingAlert = {
            alertType: 'PRE_MATURITY_24H',
            severity: 'INFO',
            contractId: schedule.contractId,
            beneficiary: schedule.beneficiary,
            tokenAddress: schedule.tokenAddress,
            amount: tranche.amount,
            unlockTimestamp: unlockTime,
            message:
              `⏳ [Vesting Milestone] Tranche #${tranche.index} (${tranche.amount} tokens) ` +
              `matures in ~${hoursRemaining} hour(s) for beneficiary ${schedule.beneficiary.slice(0, 8)}...`,
            timestamp: new Date(currentTimestampSeconds * 1000).toISOString(),
          };

          alerts.push(alert);
          await this.markAlertSent(alertKey, TWENTY_FOUR_HOURS_SECONDS * 2);
          logger.info(alert.message);
        }
      }

      // 2. Immediate Unlock Alert
      if (timeRemaining <= 0 && Math.abs(timeRemaining) <= 3600) {
        const unlockAlertKey = `vesting:unlocked_alert:${schedule.contractId}:${tranche.index}`;
        const alreadyAlerted = await this.hasAlertBeenSent(unlockAlertKey);

        if (!alreadyAlerted) {
          const alert: VestingAlert = {
            alertType: 'TRANCHE_UNLOCKED',
            severity: 'INFO',
            contractId: schedule.contractId,
            beneficiary: schedule.beneficiary,
            tokenAddress: schedule.tokenAddress,
            amount: tranche.amount,
            unlockTimestamp: unlockTime,
            message:
              `🎉 [Vesting Unlocked] Tranche #${tranche.index} (${tranche.amount} tokens) is now UNLOCKED ` +
              `and claimable by beneficiary ${schedule.beneficiary.slice(0, 8)}...`,
            timestamp: new Date(currentTimestampSeconds * 1000).toISOString(),
          };

          alerts.push(alert);
          await this.markAlertSent(unlockAlertKey, 86400 * 30);
          logger.info(alert.message);
        }
      }
    }

    return alerts;
  }

  /**
   * Generates default milestone tranches (Cliff unlock & Final maturity) if custom tranches are omitted.
   */
  public deriveDefaultTranches(schedule: VestingSchedule): VestingTranche[] {
    const tranches: VestingTranche[] = [];
    const total = BigInt(schedule.totalAmount);

    if (schedule.cliffDuration > 0) {
      const cliffUnlockTime = schedule.startTime + schedule.cliffDuration;
      const cliffAmount = schedule.cliffAmount
        ? schedule.cliffAmount
        : ((total * BigInt(schedule.cliffDuration)) / BigInt(schedule.duration)).toString();

      tranches.push({
        index: 1,
        unlockTimestamp: cliffUnlockTime,
        amount: cliffAmount,
        percent: Math.round((Number(cliffAmount) / Number(schedule.totalAmount)) * 100),
        isUnlocked: false,
      });
    }

    const finalUnlockTime = schedule.startTime + schedule.duration;
    tranches.push({
      index: tranches.length + 1,
      unlockTimestamp: finalUnlockTime,
      amount: schedule.totalAmount,
      percent: 100,
      isUnlocked: false,
    });

    return tranches;
  }

  /**
   * Instantly creates a CRITICAL security alert when an administrative clawback is observed.
   */
  public handleClawbackEvent(
    contractId: string,
    beneficiary: string,
    amount: string,
    tokenAddress: string = 'SAC_TOKEN',
    reason?: string,
  ): VestingAlert {
    const alert: VestingAlert = {
      alertType: 'CLAWBACK_TRIGGERED',
      severity: 'CRITICAL',
      contractId,
      beneficiary,
      tokenAddress,
      amount,
      reason: reason || 'Administrative clawback invoked by contract owner',
      message:
        `🚨 [Vesting Clawback] Immediate clawback executed on contract ${contractId.slice(0, 8)}... ` +
        `Amount: ${amount} tokens retrieved from beneficiary ${beneficiary.slice(0, 8)}... Reason: ${reason || 'Admin action'}`,
      timestamp: new Date().toISOString(),
    };

    logger.warn(alert.message);
    return alert;
  }

  /**
   * Instantly creates a CRITICAL security alert when a vesting contract schedule is cancelled.
   */
  public handleCancellationEvent(
    contractId: string,
    beneficiary: string,
    tokenAddress: string = 'SAC_TOKEN',
    reason?: string,
  ): VestingAlert {
    const alert: VestingAlert = {
      alertType: 'VESTING_CANCELLED',
      severity: 'CRITICAL',
      contractId,
      beneficiary,
      tokenAddress,
      amount: '0',
      reason: reason || 'Schedule terminated by governance or treasury multisig',
      message:
        `🚨 [Vesting Cancelled] Schedule cancelled on contract ${contractId.slice(0, 8)}... ` +
        `Beneficiary: ${beneficiary.slice(0, 8)}... Reason: ${reason || 'Schedule revoked'}`,
      timestamp: new Date().toISOString(),
    };

    logger.warn(alert.message);
    return alert;
  }

  /**
   * Decodes vesting contract instance storage parameters into a typed VestingSchedule.
   */
  public readContractVestingStorage(contractId: string, storageEntry: any): VestingSchedule | null {
    try {
      if (!storageEntry) return null;

      const startTime = Number(storageEntry.start_time || storageEntry.startTime || Date.now() / 1000);
      const duration = Number(storageEntry.duration || 31536000); // Default 1 year
      const cliffDuration = Number(storageEntry.cliff_duration || storageEntry.cliffDuration || 0);
      const beneficiary = String(storageEntry.beneficiary || storageEntry.recipient || '');
      const tokenAddress = String(storageEntry.token || storageEntry.tokenAddress || 'TOKEN');
      const totalAmount = String(storageEntry.total_amount || storageEntry.totalAmount || '0');

      return {
        contractId,
        beneficiary,
        tokenAddress,
        totalAmount,
        startTime,
        duration,
        cliffDuration,
        revocable: Boolean(storageEntry.revocable),
        clawbackEnabled: Boolean(storageEntry.clawback_enabled ?? true),
        tranches: storageEntry.tranches || [],
      };
    } catch (err) {
      logger.debug({ err }, 'Failed decoding vesting contract storage');
      return null;
    }
  }

  private async hasAlertBeenSent(key: string): Promise<boolean> {
    if (fallbackMemoryCache.exists(key)) return true;
    try {
      if (!isRedisDegraded()) {
        const val = await redis.get(key);
        return val !== null;
      }
    } catch {
      // Degraded
    }
    return false;
  }

  private async markAlertSent(key: string, ttlSeconds: number): Promise<void> {
    fallbackMemoryCache.set(key, 'sent', ttlSeconds);
    try {
      if (!isRedisDegraded()) {
        await redis.set(key, 'sent', 'EX', ttlSeconds);
      }
    } catch {
      // Degraded
    }
  }
}

export const vestingWatcherService = new VestingWatcherService();
