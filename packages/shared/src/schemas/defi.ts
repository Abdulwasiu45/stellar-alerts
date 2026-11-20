import { z } from 'zod';

export const collateralPositionSchema = z.object({
  asset: z.string(),
  amount: z.string(),
  priceUsd: z.number().nonnegative().optional(),
  collateralFactor: z.number().min(0).max(1).default(0.8),
});
export type CollateralPosition = z.infer<typeof collateralPositionSchema>;

export const debtPositionSchema = z.object({
  asset: z.string(),
  amount: z.string(),
  priceUsd: z.number().nonnegative().optional(),
});
export type DebtPosition = z.infer<typeof debtPositionSchema>;

export const lendingPositionSchema = z.object({
  userAddress: z.string(),
  protocol: z.string().default('blend'),
  contractId: z.string(),
  collaterals: z.array(collateralPositionSchema).default([]),
  debts: z.array(debtPositionSchema).default([]),
  healthFactor: z.number(),
  warningThreshold: z.number().default(1.15),
  isLiquidatable: z.boolean().default(false),
  updatedAt: z.string(),
});
export type LendingPosition = z.infer<typeof lendingPositionSchema>;

export const liquidationEventSchema = z.object({
  id: z.string().optional(),
  txHash: z.string(),
  ledgerSeq: z.number().int().nonnegative(),
  protocol: z.string().default('blend'),
  contractId: z.string(),
  liquidator: z.string(),
  borrower: z.string(),
  collateralAsset: z.string(),
  debtAsset: z.string(),
  debtRepaid: z.string(),
  collateralSeized: z.string(),
  timestamp: z.string(),
});
export type LiquidationEvent = z.infer<typeof liquidationEventSchema>;

export const lendingAlertTypeSchema = z.enum([
  'HEALTH_FACTOR_WARNING',
  'LIQUIDATION_RISK',
  'LIQUIDATION_EXECUTED',
]);
export type LendingAlertType = z.infer<typeof lendingAlertTypeSchema>;

export const lendingAlertSchema = z.object({
  type: lendingAlertTypeSchema,
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  userAddress: z.string(),
  contractId: z.string(),
  protocol: z.string().default('blend'),
  healthFactor: z.number().optional(),
  warningThreshold: z.number().optional(),
  liquidationDetails: liquidationEventSchema.optional(),
  message: z.string(),
  timestamp: z.string(),
});
export type LendingAlert = z.infer<typeof lendingAlertSchema>;
