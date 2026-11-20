import { createLogger } from '../../lib/logger';
import {
  CollateralPosition,
  DebtPosition,
  LendingPosition,
  LiquidationEvent,
  LendingAlert,
} from '@stellar-alerts/shared';

const logger = createLogger({ module: 'LendingTrackerService' });

export interface HealthFactorResult {
  healthFactor: number;
  totalCollateralUsd: number;
  discountedCollateralUsd: number;
  totalDebtUsd: number;
  isLiquidatable: boolean;
}

export interface MonitoredUserLendingKey {
  contractId: string;
  userAddress: string;
}

export class LendingTrackerService {
  private monitoredPositions = new Map<string, LendingPosition>();

  private getPositionKey(contractId: string, userAddress: string): string {
    return `${contractId.toLowerCase()}:${userAddress.toLowerCase()}`;
  }

  /**
   * Calculates the health factor for a user's lending and borrowing position.
   * Health Factor = (Sum of [Collateral Amount * Asset Price * Collateral Factor]) / (Sum of [Debt Amount * Asset Price])
   *
   * A health factor >= 1.0 indicates a healthy, adequately collateralized position.
   * A health factor < 1.0 indicates undercollateralization eligible for liquidation.
   * If total debt is 0, health factor is Infinity (safe).
   */
  public calculateHealthFactor(
    collaterals: CollateralPosition[],
    debts: DebtPosition[],
    priceOverrides?: Record<string, number>,
  ): HealthFactorResult {
    let totalCollateralUsd = 0;
    let discountedCollateralUsd = 0;
    let totalDebtUsd = 0;

    for (const col of collaterals) {
      const amount = parseFloat(col.amount) || 0;
      const price = priceOverrides?.[col.asset] ?? col.priceUsd ?? 0;
      const cf = col.collateralFactor !== undefined ? col.collateralFactor : 0.8;

      const colValue = amount * price;
      totalCollateralUsd += colValue;
      discountedCollateralUsd += colValue * cf;
    }

    for (const debt of debts) {
      const amount = parseFloat(debt.amount) || 0;
      const price = priceOverrides?.[debt.asset] ?? debt.priceUsd ?? 0;
      totalDebtUsd += amount * price;
    }

    if (totalDebtUsd <= 0) {
      return {
        healthFactor: Infinity,
        totalCollateralUsd,
        discountedCollateralUsd,
        totalDebtUsd: 0,
        isLiquidatable: false,
      };
    }

    const healthFactor = discountedCollateralUsd / totalDebtUsd;
    const isLiquidatable = healthFactor < 1.0;

    return {
      healthFactor: Math.round(healthFactor * 10000) / 10000,
      totalCollateralUsd: Math.round(totalCollateralUsd * 100) / 100,
      discountedCollateralUsd: Math.round(discountedCollateralUsd * 100) / 100,
      totalDebtUsd: Math.round(totalDebtUsd * 100) / 100,
      isLiquidatable,
    };
  }

  /**
   * Evaluates position against warning thresholds and generates an alert if health factor is critical or warning.
   */
  public evaluatePositionAlert(
    position: LendingPosition,
    threshold: number = position.warningThreshold || 1.15,
  ): LendingAlert | null {
    const timestamp = new Date().toISOString();

    if (position.isLiquidatable || position.healthFactor < 1.0) {
      return {
        type: 'LIQUIDATION_RISK',
        severity: 'CRITICAL',
        userAddress: position.userAddress,
        contractId: position.contractId,
        protocol: position.protocol,
        healthFactor: position.healthFactor,
        warningThreshold: threshold,
        message:
          `CRITICAL: Lending position for user ${position.userAddress} on ${position.protocol} ` +
          `is undercollateralized with health factor ${position.healthFactor.toFixed(3)} (< 1.0). Immediate liquidation risk!`,
        timestamp,
      };
    }

    if (position.healthFactor <= threshold) {
      return {
        type: 'HEALTH_FACTOR_WARNING',
        severity: 'WARNING',
        userAddress: position.userAddress,
        contractId: position.contractId,
        protocol: position.protocol,
        healthFactor: position.healthFactor,
        warningThreshold: threshold,
        message:
          `WARNING: Health factor for borrower ${position.userAddress} on ${position.protocol} ` +
          `has dropped to ${position.healthFactor.toFixed(3)} (below warning threshold ${threshold}).`,
        timestamp,
      };
    }

    return null;
  }

  /**
   * Tracks or updates a user's position in memory/state.
   */
  public updatePosition(
    contractId: string,
    userAddress: string,
    collaterals: CollateralPosition[],
    debts: DebtPosition[],
    options?: {
      protocol?: string;
      warningThreshold?: number;
      priceOverrides?: Record<string, number>;
    },
  ): { position: LendingPosition; alert: LendingAlert | null } {
    const protocol = options?.protocol || 'blend';
    const warningThreshold = options?.warningThreshold || 1.15;
    const hfResult = this.calculateHealthFactor(collaterals, debts, options?.priceOverrides);

    const position: LendingPosition = {
      userAddress,
      protocol,
      contractId,
      collaterals,
      debts,
      healthFactor: hfResult.healthFactor,
      warningThreshold,
      isLiquidatable: hfResult.isLiquidatable,
      updatedAt: new Date().toISOString(),
    };

    const key = this.getPositionKey(contractId, userAddress);
    this.monitoredPositions.set(key, position);

    const alert = this.evaluatePositionAlert(position, warningThreshold);
    if (alert) {
      logger.warn(
        { userAddress, contractId, healthFactor: position.healthFactor, severity: alert.severity },
        alert.message,
      );
    }

    return { position, alert };
  }

  public getPosition(contractId: string, userAddress: string): LendingPosition | undefined {
    return this.monitoredPositions.get(this.getPositionKey(contractId, userAddress));
  }

  public getAllPositions(): LendingPosition[] {
    return Array.from(this.monitoredPositions.values());
  }

  public clearPositions(): void {
    this.monitoredPositions.clear();
  }

  /**
   * Parses contract events to detect and structure liquidation invocations across Blend / Soroban lending protocols.
   */
  public parseLiquidationEvent(raw: {
    topic?: unknown[];
    value?: unknown;
    data?: unknown;
    contractId?: string;
    txHash?: string;
    transactionHash?: string;
    ledgerSeq?: number;
    ledger?: number;
  }): LiquidationEvent | null {
    if (!raw.topic || !Array.isArray(raw.topic) || raw.topic.length === 0) {
      return null;
    }

    const topicStrings = raw.topic.map((t) => {
      if (typeof t === 'string') return t;
      if (t && typeof t === 'object' && 'value' in t) return String((t as { value: unknown }).value);
      return String(t);
    });

    const isLiquidation = topicStrings.some((t) => {
      const lower = t.toLowerCase();
      return (
        lower.includes('liquidat') ||
        lower === 'liquidation' ||
        lower === 'liquidate' ||
        lower === 'liquidate_position'
      );
    });

    if (!isLiquidation) {
      return null;
    }

    const val = (raw.value || raw.data || {}) as Record<string, unknown>;
    const contractId =
      raw.contractId ||
      (typeof val.contract_id === 'string' ? val.contract_id : '') ||
      (typeof val.contractId === 'string' ? val.contractId : '');

    const txHash =
      raw.txHash ||
      raw.transactionHash ||
      (typeof val.txHash === 'string' ? val.txHash : '') ||
      'unknown_tx';

    const ledgerSeq = raw.ledgerSeq ?? raw.ledger ?? (typeof val.ledgerSeq === 'number' ? val.ledgerSeq : 0);

    const borrower =
      (typeof val.borrower === 'string' ? val.borrower : '') ||
      (typeof val.user === 'string' ? val.user : '') ||
      (typeof val.user_address === 'string' ? val.user_address : '') ||
      topicStrings[1] ||
      '';

    const liquidator =
      (typeof val.liquidator === 'string' ? val.liquidator : '') ||
      (typeof val.caller === 'string' ? val.caller : '') ||
      '';

    const collateralAsset =
      (typeof val.collateral_asset === 'string' ? val.collateral_asset : '') ||
      (typeof val.collateral_token === 'string' ? val.collateral_token : '') ||
      (typeof val.collateralAsset === 'string' ? val.collateralAsset : '') ||
      'UNKNOWN_ASSET';

    const debtAsset =
      (typeof val.debt_asset === 'string' ? val.debt_asset : '') ||
      (typeof val.debt_token === 'string' ? val.debt_token : '') ||
      (typeof val.debtAsset === 'string' ? val.debtAsset : '') ||
      'UNKNOWN_ASSET';

    const debtRepaid = String(
      val.debt_repaid ?? val.debtRepaid ?? val.repaid_amount ?? val.amount_repaid ?? '0',
    );

    const collateralSeized = String(
      val.collateral_seized ?? val.collateralSeized ?? val.seized_amount ?? val.amount_seized ?? '0',
    );

    return {
      txHash,
      ledgerSeq,
      protocol: 'blend',
      contractId,
      liquidator,
      borrower,
      collateralAsset,
      debtAsset,
      debtRepaid,
      collateralSeized,
      timestamp: new Date().toISOString(),
    };
  }
}

export const lendingTrackerService = new LendingTrackerService();
