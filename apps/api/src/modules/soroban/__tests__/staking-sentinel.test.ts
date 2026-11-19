import { describe, it, expect, beforeEach } from 'vitest';
import {
  StakingSentinelService,
  stakingSentinelService,
} from '../staking-sentinel.service';
import { parseStakingEvent } from '../../../workers/staking.worker';

describe('StakingSentinelService', () => {
  const service = new StakingSentinelService();
  const poolId = 'C_STAKING_POOL_TEST_1';

  beforeEach(async () => {
    await service.resetPoolState(poolId);
  });

  it('calculates APR accurately from annual rewards and TVL', () => {
    // 10,000 rewards / 100,000 TVL = 10%
    const apr = service.calculateApr(10000, 100000);
    expect(apr).toBe(10);

    // If TVL halves to 50,000, APR doubles to 20%
    const updatedApr = service.calculateApr(10000, 50000);
    expect(updatedApr).toBe(20);

    // Edge cases: 0 TVL or 0 emission
    expect(service.calculateApr(0, 100000)).toBe(0);
    expect(service.calculateApr(10000, 0)).toBe(0);
  });

  it('registers pool and persists initial state', async () => {
    const state = await service.registerPool({
      poolId,
      initialTvl: 1_000_000,
      annualRewardEmission: 120_000,
      stakeTokenSymbol: 'XLM',
      rewardTokenSymbol: 'REWARD',
    });

    expect(state.poolId).toBe(poolId);
    expect(state.currentTvl).toBe(1_000_000);
    expect(state.annualRewardEmission).toBe(120_000);

    const fetched = await service.getPoolState(poolId);
    expect(fetched?.currentTvl).toBe(1_000_000);
  });

  it('does NOT trigger alert when net withdrawals are below 15%', async () => {
    const now = Date.now();
    await service.registerPool({
      poolId,
      initialTvl: 100_000,
      annualRewardEmission: 10_000,
    });

    // 10% withdrawal (10,000 out of 100,000)
    const alert = await service.recordEvent({
      poolId,
      type: 'withdraw',
      amount: 10_000,
      timestamp: now,
    });

    expect(alert).toBeNull();
    const state = await service.getPoolState(poolId);
    expect(state?.currentTvl).toBe(90_000);
  });

  it('triggers critical alert when net withdrawals exceed 15% in a 1-hour rolling window', async () => {
    const now = Date.now();
    await service.registerPool({
      poolId,
      initialTvl: 100_000,
      annualRewardEmission: 10_000,
    });

    // 20% withdrawal (20,000 out of 100,000)
    const alert = await service.recordEvent({
      poolId,
      type: 'withdraw',
      amount: 20_000,
      timestamp: now,
    });

    expect(alert).not.toBeNull();
    expect(alert?.alertType).toBe('tvl_drop_exceeded_15_percent');
    expect(alert?.severity).toBe('CRITICAL');
    expect(alert?.dropPercentage).toBe(20);
    expect(alert?.netWithdrawalAmount).toBe(20_000);
    expect(alert?.previousTvl).toBe(100_000);
    expect(alert?.currentTvl).toBe(80_000);
    expect(alert?.previousAprPercentage).toBe(10); // 10,000 / 100,000 = 10%
    expect(alert?.updatedAprPercentage).toBe(12.5); // 10,000 / 80,000 = 12.5%
    expect(alert?.windowDurationSeconds).toBe(3600);
  });

  it('ignores withdrawals older than the 1-hour window', async () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;

    await service.registerPool({
      poolId,
      initialTvl: 100_000,
      annualRewardEmission: 10_000,
    });

    // Old withdrawal 2 hours ago
    await service.recordEvent({
      poolId,
      type: 'withdraw',
      amount: 30_000,
      timestamp: twoHoursAgo,
    });

    // Check shift at current time: the 30k was outside the 1-hour window
    const alert = await service.checkTvlShift(poolId, now);
    expect(alert).toBeNull();
  });

  it('correctly offsets withdrawals when deposits occur within the same window', async () => {
    const now = Date.now();
    await service.registerPool({
      poolId,
      initialTvl: 100_000,
      annualRewardEmission: 10_000,
    });

    // 25,000 withdrawal
    await service.recordEvent({
      poolId,
      type: 'withdraw',
      amount: 25_000,
      timestamp: now - 1000,
    });

    // Followed by 20,000 deposit => net withdrawal is only 5,000 (5% of 100k, below 15%)
    const alert = await service.recordEvent({
      poolId,
      type: 'deposit',
      amount: 20_000,
      timestamp: now,
    });

    expect(alert).toBeNull();
  });

  it('parseStakingEvent correctly extracts event details from raw topics and payloads', () => {
    const rawDeposit = {
      topic: ['staking', 'deposit'],
      amount: '5000',
      account: 'GUSER_123',
      transaction_hash: '0xhash1',
    };
    const parsedDeposit = parseStakingEvent(rawDeposit, poolId);
    expect(parsedDeposit).not.toBeNull();
    expect(parsedDeposit?.type).toBe('deposit');
    expect(parsedDeposit?.amount).toBe(5000);

    const rawWithdraw = {
      topic: ['unstake'],
      amount: 2500,
      account: 'GUSER_456',
    };
    const parsedWithdraw = parseStakingEvent(rawWithdraw, poolId);
    expect(parsedWithdraw).not.toBeNull();
    expect(parsedWithdraw?.type).toBe('withdraw');
    expect(parsedWithdraw?.amount).toBe(2500);

    const rawIrrelevant = {
      topic: ['transfer', 'sac'],
      amount: 100,
    };
    expect(parseStakingEvent(rawIrrelevant, poolId)).toBeNull();
  });
});
