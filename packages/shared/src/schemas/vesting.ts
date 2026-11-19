import { z } from 'zod';

export const vestingTrancheSchema = z.object({
  index: z.number().int().nonnegative(),
  unlockTimestamp: z.number().int().positive(),
  amount: z.string(),
  percent: z.number().min(0).max(100),
  isUnlocked: z.boolean().default(false),
});
export type VestingTranche = z.infer<typeof vestingTrancheSchema>;

export const vestingScheduleSchema = z.object({
  contractId: z.string(),
  beneficiary: z.string(),
  tokenAddress: z.string(),
  totalAmount: z.string(),
  startTime: z.number().int().positive(),
  duration: z.number().int().positive(),
  cliffDuration: z.number().int().nonnegative().default(0),
  cliffAmount: z.string().optional(),
  revocable: z.boolean().default(false),
  clawbackEnabled: z.boolean().default(false),
  tranches: z.array(vestingTrancheSchema).optional().default([]),
});
export type VestingSchedule = z.infer<typeof vestingScheduleSchema>;

export const vestingAlertTypeSchema = z.enum([
  'PRE_MATURITY_24H',
  'TRANCHE_UNLOCKED',
  'CLAWBACK_TRIGGERED',
  'VESTING_CANCELLED',
]);
export type VestingAlertType = z.infer<typeof vestingAlertTypeSchema>;

export const vestingAlertSchema = z.object({
  alertType: vestingAlertTypeSchema,
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  contractId: z.string(),
  beneficiary: z.string(),
  tokenAddress: z.string(),
  amount: z.string(),
  unlockTimestamp: z.number().int().positive().optional(),
  reason: z.string().optional(),
  message: z.string(),
  timestamp: z.string(),
});
export type VestingAlert = z.infer<typeof vestingAlertSchema>;
