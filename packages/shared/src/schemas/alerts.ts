import { z } from 'zod';

export const flashLoanAlertSchema = z.object({
  id: z.string().optional(),
  type: z.literal('FLASH_LOAN_DETECTED'),
  priority: z.literal('HIGH'),
  txHash: z.string(),
  ledgerSeq: z.number().int().nonnegative(),
  protocolContractId: z.string(),
  borrowedAsset: z.string(),
  borrowedAmount: z.string(),
  repaidAmount: z.string(),
  feeAmount: z.string(),
  netArbitrageProfit: z.string(),
  targetArbitrageContracts: z.array(z.string()).default([]),
  timestamp: z.string(),
  durationMs: z.number().optional(),
});

export type FlashLoanAlert = z.infer<typeof flashLoanAlertSchema>;

export const alertNotificationSchema = z.object({
  alertType: z.string(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  txHash: z.string().optional(),
  contractId: z.string().optional(),
  message: z.string(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.string(),
});

export type AlertNotification = z.infer<typeof alertNotificationSchema>;
