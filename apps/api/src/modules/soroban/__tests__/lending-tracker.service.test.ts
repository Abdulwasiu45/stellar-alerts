import { describe, it, expect, beforeEach } from 'vitest';
import {
  LendingTrackerService,
  lendingTrackerService,
} from '../lending-tracker.service';
import {
  runLendingWatcherPass,
  processLiquidationEvent,
} from '../../../workers/lending-watcher.worker';
import { CollateralPosition, DebtPosition, LendingAlert } from '@stellar-alerts/shared';

describe('LendingTrackerService & LendingWatcherWorker (#900)', () => {
  let service: LendingTrackerService;

  beforeEach(() => {
    service = new LendingTrackerService();
  });

  describe('Health Factor Calculation', () => {
    it('calculates health factor correctly for single collateral and debt', () => {
      // Collateral: 1,000 USDC at $1.00 with 0.80 collateral factor = $800 discounted
      const collaterals: CollateralPosition[] = [
        { asset: 'USDC', amount: '1000', priceUsd: 1.0, collateralFactor: 0.8 },
      ];
      // Debt: 1,000 XLM at $0.50 = $500 debt
      const debts: DebtPosition[] = [
        { asset: 'XLM', amount: '1000', priceUsd: 0.5 },
      ];

      const result = service.calculateHealthFactor(collaterals, debts);
      // Expected HF = 800 / 500 = 1.6
      expect(result.healthFactor).toBe(1.6);
      expect(result.totalCollateralUsd).toBe(1000);
      expect(result.discountedCollateralUsd).toBe(800);
      expect(result.totalDebtUsd).toBe(500);
      expect(result.isLiquidatable).toBe(false);
    });

    it('identifies undercollateralized positions eligible for liquidation (HF < 1.0)', () => {
      // Collateral: 1,000 USDC at $1.00 with 0.75 CF = $750 discounted
      const collaterals: CollateralPosition[] = [
        { asset: 'USDC', amount: '1000', priceUsd: 1.0, collateralFactor: 0.75 },
      ];
      // Debt: $900
      const debts: DebtPosition[] = [
        { asset: 'AQUA', amount: '900', priceUsd: 1.0 },
      ];

      const result = service.calculateHealthFactor(collaterals, debts);
      // Expected HF = 750 / 900 = 0.8333
      expect(result.healthFactor).toBeCloseTo(0.8333, 3);
      expect(result.isLiquidatable).toBe(true);
    });

    it('returns Infinity for positions with zero debt', () => {
      const collaterals: CollateralPosition[] = [
        { asset: 'XLM', amount: '5000', priceUsd: 0.25, collateralFactor: 0.8 },
      ];
      const debts: DebtPosition[] = [];

      const result = service.calculateHealthFactor(collaterals, debts);
      expect(result.healthFactor).toBe(Infinity);
      expect(result.totalDebtUsd).toBe(0);
      expect(result.isLiquidatable).toBe(false);
    });

    it('calculates health factor across multi-collateral and multi-debt portfolios', () => {
      const collaterals: CollateralPosition[] = [
        { asset: 'USDC', amount: '2000', priceUsd: 1.0, collateralFactor: 0.8 }, // 2000 * 0.8 = 1600
        { asset: 'ETH', amount: '1', priceUsd: 3000.0, collateralFactor: 0.7 },   // 3000 * 0.7 = 2100
      ];
      // Total discounted collateral = 1600 + 2100 = 3700

      const debts: DebtPosition[] = [
        { asset: 'XLM', amount: '10000', priceUsd: 0.2 }, // 2000
        { asset: 'EURC', amount: '1000', priceUsd: 1.1 }, // 1100
      ];
      // Total debt = 2000 + 1100 = 3100

      const result = service.calculateHealthFactor(collaterals, debts);
      // Expected HF = 3700 / 3100 = 1.1935
      expect(result.healthFactor).toBeCloseTo(1.1935, 3);
      expect(result.totalCollateralUsd).toBe(5000);
      expect(result.discountedCollateralUsd).toBe(3700);
      expect(result.totalDebtUsd).toBe(3100);
      expect(result.isLiquidatable).toBe(false);
    });

    it('applies price overrides dynamically from oracle feeds', () => {
      const collaterals: CollateralPosition[] = [
        { asset: 'XLM', amount: '10000', priceUsd: 0.1, collateralFactor: 0.8 },
      ];
      const debts: DebtPosition[] = [
        { asset: 'USDC', amount: '1000', priceUsd: 1.0 },
      ];

      // With price override XLM = $0.20: discounted collateral = 10000 * 0.2 * 0.8 = 1600
      const result = service.calculateHealthFactor(collaterals, debts, { XLM: 0.2 });
      expect(result.healthFactor).toBe(1.6);
    });
  });

  describe('Position Tracking & Threshold Alerting', () => {
    it('triggers HEALTH_FACTOR_WARNING when health factor falls below user-configured threshold (1.15)', () => {
      const collaterals: CollateralPosition[] = [
        { asset: 'USDC', amount: '1100', priceUsd: 1.0, collateralFactor: 1.0 },
      ];
      const debts: DebtPosition[] = [
        { asset: 'USDT', amount: '1000', priceUsd: 1.0 },
      ];

      // HF = 1100 / 1000 = 1.10 (between 1.0 and 1.15)
      const { position, alert } = service.updatePosition('C_BLEND_POOL', 'G_BORROWER_1', collaterals, debts, {
        warningThreshold: 1.15,
      });

      expect(position.healthFactor).toBe(1.1);
      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('HEALTH_FACTOR_WARNING');
      expect(alert?.severity).toBe('WARNING');
      expect(alert?.userAddress).toBe('G_BORROWER_1');
    });

    it('triggers LIQUIDATION_RISK with CRITICAL severity when health factor < 1.0', () => {
      const collaterals: CollateralPosition[] = [
        { asset: 'USDC', amount: '950', priceUsd: 1.0, collateralFactor: 1.0 },
      ];
      const debts: DebtPosition[] = [
        { asset: 'USDT', amount: '1000', priceUsd: 1.0 },
      ];

      // HF = 950 / 1000 = 0.95
      const { position, alert } = service.updatePosition('C_BLEND_POOL', 'G_BORROWER_2', collaterals, debts);

      expect(position.healthFactor).toBe(0.95);
      expect(position.isLiquidatable).toBe(true);
      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('LIQUIDATION_RISK');
      expect(alert?.severity).toBe('CRITICAL');
    });

    it('returns null when health factor is safely above threshold', () => {
      const collaterals: CollateralPosition[] = [
        { asset: 'USDC', amount: '2000', priceUsd: 1.0, collateralFactor: 0.8 },
      ];
      const debts: DebtPosition[] = [
        { asset: 'USDT', amount: '1000', priceUsd: 1.0 },
      ];

      // HF = 1600 / 1000 = 1.6 > 1.15
      const { alert } = service.updatePosition('C_BLEND_POOL', 'G_BORROWER_SAFE', collaterals, debts);
      expect(alert).toBeNull();
    });
  });

  describe('Liquidation Event Topic Parser', () => {
    it('parses Blend liquidation events and extracts all relevant fields', () => {
      const rawEvent = {
        contractId: 'C_BLEND_LENDING_CONTRACT',
        txHash: 'tx_hash_liquidation_123456789',
        ledgerSeq: 123456,
        topic: ['liquidation', 'G_BORROWER_ADDR'],
        value: {
          liquidator: 'G_LIQUIDATOR_ADDR',
          borrower: 'G_BORROWER_ADDR',
          collateral_asset: 'CD_COLLATERAL_TOKEN',
          debt_asset: 'CD_DEBT_TOKEN',
          debt_repaid: '50000000',
          collateral_seized: '55000000',
        },
      };

      const parsed = service.parseLiquidationEvent(rawEvent);
      expect(parsed).not.toBeNull();
      expect(parsed?.contractId).toBe('C_BLEND_LENDING_CONTRACT');
      expect(parsed?.txHash).toBe('tx_hash_liquidation_123456789');
      expect(parsed?.ledgerSeq).toBe(123456);
      expect(parsed?.liquidator).toBe('G_LIQUIDATOR_ADDR');
      expect(parsed?.borrower).toBe('G_BORROWER_ADDR');
      expect(parsed?.collateralAsset).toBe('CD_COLLATERAL_TOKEN');
      expect(parsed?.debtAsset).toBe('CD_DEBT_TOKEN');
      expect(parsed?.debtRepaid).toBe('50000000');
      expect(parsed?.collateralSeized).toBe('55000000');
    });

    it('returns null for non-liquidation topics', () => {
      const transferEvent = {
        topic: ['transfer', 'G_FROM', 'G_TO'],
        value: { amount: '1000' },
      };
      expect(service.parseLiquidationEvent(transferEvent)).toBeNull();
    });
  });

  describe('Lending Watcher Worker Integration', () => {
    it('runs lending watcher pass and dispatches alerts for vulnerable positions', async () => {
      const notifiedAlerts: LendingAlert[] = [];
      const testPositions = [
        {
          userAddress: 'G_USER_RISKY',
          protocol: 'blend',
          contractId: 'C_BLEND_POOL',
          collaterals: [{ asset: 'USDC', amount: '110', priceUsd: 1, collateralFactor: 1 }],
          debts: [{ asset: 'XLM', amount: '100', priceUsd: 1 }],
          healthFactor: 1.1,
          warningThreshold: 1.15,
          isLiquidatable: false,
          updatedAt: new Date().toISOString(),
        },
      ];

      const alerts = await runLendingWatcherPass({
        service,
        positions: testPositions,
        notify: (a) => {
          notifiedAlerts.push(a);
        },
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].type).toBe('HEALTH_FACTOR_WARNING');
      expect(notifiedAlerts).toHaveLength(1);
    });

    it('processes liquidation event and invokes notifier with CRITICAL alert', async () => {
      const notifiedAlerts: LendingAlert[] = [];
      const rawLiquidation = {
        contractId: 'C_BLEND',
        txHash: 'tx_liq_999',
        ledgerSeq: 8888,
        topic: ['liquidate', 'G_BORROWER'],
        value: {
          liquidator: 'G_LIQ',
          collateral_token: 'USDC',
          debt_token: 'XLM',
          repaid_amount: '100',
          seized_amount: '120',
        },
      };

      const result = await processLiquidationEvent(rawLiquidation, {
        service,
        notify: (a) => {
          notifiedAlerts.push(a);
        },
      });

      expect(result).not.toBeNull();
      expect(notifiedAlerts).toHaveLength(1);
      expect(notifiedAlerts[0].type).toBe('LIQUIDATION_EXECUTED');
      expect(notifiedAlerts[0].severity).toBe('CRITICAL');
    });
  });
});
