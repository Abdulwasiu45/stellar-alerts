import { describe, it, expect, beforeEach } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import {
  FlashLoanDetector,
  flashLoanDetector,
  FlashLoanInvocationNode,
} from '../flash-loan-detector';
import { inspectTransactionForFlashLoans } from '../../../workers/watcher.worker';

describe('FlashLoanDetector & Multi-Operation Atomicity Analyzer (#897)', () => {
  let detector: FlashLoanDetector;

  beforeEach(() => {
    detector = new FlashLoanDetector();
  });

  describe('Atomic Flash Loan Detection', () => {
    it('detects atomic borrow and repay cycle with intermediate DEX arbitrage swap', () => {
      // Lender contract: C_LENDER_VAULT
      // Arbitrage target: C_DEX_SWAP_POOL
      const invocations: FlashLoanInvocationNode[] = [
        {
          contractId: 'C_LENDER_VAULT',
          functionName: 'flash_loan',
          asset: 'CD_USDC',
          amount: '1000000000', // Borrow 100 USDC
          subInvocations: [
            {
              contractId: 'C_DEX_SWAP_POOL',
              functionName: 'swap',
              asset: 'CD_USDC',
              amount: '1005000000', // Arbitrage swap yielding surplus
            },
            {
              contractId: 'C_LENDER_VAULT',
              functionName: 'repay',
              asset: 'CD_USDC',
              amount: '1000500000', // Repaid 100 USDC + 0.05 USDC fee
            },
          ],
        },
      ];

      const alert = detector.analyzeTransaction({
        txHash: '0xflashloan1234567890abcdef',
        ledgerSeq: 54321,
        invocations,
      });

      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('FLASH_LOAN_DETECTED');
      expect(alert?.priority).toBe('HIGH');
      expect(alert?.protocolContractId).toBe('C_LENDER_VAULT');
      expect(alert?.borrowedAsset).toBe('CD_USDC');
      expect(alert?.borrowedAmount).toBe('1000000000');
      expect(alert?.repaidAmount).toBe('1000500000');
      expect(alert?.feeAmount).toBe('500000'); // 1000500000 - 1000000000
      expect(alert?.targetArbitrageContracts).toContain('C_DEX_SWAP_POOL');
      expect(alert?.durationMs).toBeLessThan(1000); // Emits within <1s
    });

    it('detects flash loan from flat transaction execution trace with multiple hops', () => {
      const invocations: FlashLoanInvocationNode[] = [
        {
          contractId: 'C_FLASH_POOL',
          functionName: 'borrow',
          asset: 'XLM',
          amount: '50000000000', // 5,000 XLM
        },
        {
          contractId: 'C_AMM_ROUTER',
          functionName: 'route_trade',
          asset: 'XLM',
          amount: '50000000000',
        },
        {
          contractId: 'C_ORACLE_ARBITRAGE',
          functionName: 'execute_arb',
          asset: 'XLM',
          amount: '50000000000',
        },
        {
          contractId: 'C_FLASH_POOL',
          functionName: 'repay_loan',
          asset: 'XLM',
          amount: '50025000000', // 5,000 XLM + 2.5 XLM fee
        },
      ];

      const alert = detector.analyzeTransaction({
        txHash: '0xmulti_hop_flash_loan',
        ledgerSeq: 88888,
        invocations,
      });

      expect(alert).not.toBeNull();
      expect(alert?.protocolContractId).toBe('C_FLASH_POOL');
      expect(alert?.borrowedAsset).toBe('XLM');
      expect(alert?.feeAmount).toBe('25000000');
      expect(alert?.targetArbitrageContracts).toEqual(['C_AMM_ROUTER', 'C_ORACLE_ARBITRAGE']);
    });

    it('detects flash loan via contract events trace', () => {
      const events = [
        {
          contractId: 'C_LENDING_CORE',
          topic: ['flash_loan', 'USDC'],
          value: {
            borrowedAmount: '2000000',
            asset: 'USDC',
            fee: '1000',
          },
        },
        {
          contractId: 'C_LENDING_CORE',
          topic: ['repay', 'USDC'],
          value: {
            repaidAmount: '2001000',
            asset: 'USDC',
          },
        },
      ];

      const alert = detector.analyzeTransaction({
        txHash: '0xevent_flash_loan',
        ledgerSeq: 77777,
        events,
      });

      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('FLASH_LOAN_DETECTED');
      expect(alert?.protocolContractId).toBe('C_LENDING_CORE');
      expect(alert?.borrowedAmount).toBe('2000000');
      expect(alert?.repaidAmount).toBe('2001000');
      expect(alert?.feeAmount).toBe('1000');
    });
  });

  describe('Zero False Positives on Standard Non-Flash Transactions', () => {
    it('returns null for standard non-flash multi-operation payment envelope', () => {
      // Standard multi-op payment: e.g. paying 3 distinct recipients in 1 transaction
      const operations = [
        {
          type: 'paymentOp',
          sourceAccount: 'G_SENDER',
          destination: 'G_RECIPIENT_1',
          asset: 'XLM',
          amount: '100',
        },
        {
          type: 'paymentOp',
          sourceAccount: 'G_SENDER',
          destination: 'G_RECIPIENT_2',
          asset: 'XLM',
          amount: '200',
        },
        {
          type: 'paymentOp',
          sourceAccount: 'G_SENDER',
          destination: 'G_RECIPIENT_3',
          asset: 'USDC',
          amount: '50',
        },
      ];

      const alert = detector.analyzeTransaction({
        txHash: '0xstandard_multi_op_payment',
        ledgerSeq: 10001,
        operations,
      });

      expect(alert).toBeNull();
    });

    it('returns null for standard loan borrow without atomic same-tx repayment', () => {
      const invocations: FlashLoanInvocationNode[] = [
        {
          contractId: 'C_COLLATERALIZED_LENDER',
          functionName: 'borrow',
          asset: 'USDC',
          amount: '5000000',
        },
        {
          contractId: 'C_OTHER_CONTRACT',
          functionName: 'transfer',
          asset: 'USDC',
          amount: '5000000',
        },
      ];

      const alert = detector.analyzeTransaction({
        txHash: '0xnormal_collateralized_borrow',
        ledgerSeq: 10002,
        invocations,
      });

      expect(alert).toBeNull();
    });

    it('returns null when repayment is to a completely different contract', () => {
      const invocations: FlashLoanInvocationNode[] = [
        {
          contractId: 'C_LENDER_A',
          functionName: 'borrow',
          asset: 'USDC',
          amount: '1000000',
        },
        {
          contractId: 'C_LENDER_B',
          functionName: 'repay',
          asset: 'USDC',
          amount: '1000000',
        },
      ];

      const alert = detector.analyzeTransaction({
        txHash: '0xdifferent_contract_repay',
        ledgerSeq: 10003,
        invocations,
      });

      expect(alert).toBeNull();
    });

    it('parses simulated transaction envelope XDR with zero false positives', () => {
      // Build a real Stellar SDK transaction with 2 payments
      const sourceKeypair = StellarSdk.Keypair.random();
      const dest1 = StellarSdk.Keypair.random();
      const dest2 = StellarSdk.Keypair.random();

      const account = new StellarSdk.Account(sourceKeypair.publicKey(), '100');
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: StellarSdk.Networks.TESTNET,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: dest1.publicKey(),
            asset: StellarSdk.Asset.native(),
            amount: '10',
          }),
        )
        .addOperation(
          StellarSdk.Operation.payment({
            destination: dest2.publicKey(),
            asset: StellarSdk.Asset.native(),
            amount: '20',
          }),
        )
        .setTimeout(30)
        .build();

      const envelopeXdr = tx.toEnvelope().toXDR('base64');
      const alert = detector.analyzeTransactionEnvelopeXdr(envelopeXdr, tx.hash().toString('hex'), 9999);

      expect(alert).toBeNull();
    });
  });

  describe('Watcher Worker Integration', () => {
    it('inspects transactions in watcher worker helper', async () => {
      const alert = await inspectTransactionForFlashLoans({
        txHash: '0xwatcher_test_tx',
        ledgerSeq: 60000,
        invocations: [
          {
            contractId: 'C_FLASH_LENDER',
            functionName: 'flash_loan',
            asset: 'XLM',
            amount: '100000000',
            subInvocations: [
              {
                contractId: 'C_FLASH_LENDER',
                functionName: 'repay',
                asset: 'XLM',
                amount: '100010000',
              },
            ],
          },
        ],
      });

      expect(alert).not.toBeNull();
      expect(alert?.type).toBe('FLASH_LOAN_DETECTED');
      expect(alert?.protocolContractId).toBe('C_FLASH_LENDER');
    });
  });
});
