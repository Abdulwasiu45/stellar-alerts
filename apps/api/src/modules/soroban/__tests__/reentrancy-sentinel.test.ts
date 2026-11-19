import { describe, it, expect } from 'vitest';
import {
  ReentrancySentinel,
  SorobanInvocationNode,
  reentrancySentinel,
} from '../reentrancy-sentinel';

describe('ReentrancySentinel', () => {
  const sentinel = new ReentrancySentinel();

  it('validates linear execution tree as clean and safe', () => {
    // Tree: ContractA::main -> ContractB::compute -> ContractC::store
    const root: SorobanInvocationNode = {
      contractId: 'ContractA',
      functionName: 'main',
      subInvocations: [
        {
          contractId: 'ContractB',
          functionName: 'compute',
          subInvocations: [
            {
              contractId: 'ContractC',
              functionName: 'store',
              subInvocations: [],
            },
          ],
        },
      ],
    };

    const report = sentinel.analyzeInvocationTree(root, 'tx_clean_1');

    expect(report.hasReentrancy).toBe(false);
    expect(report.incidents.length).toBe(0);
    expect(report.riskLevel).toBe('SAFE');
    expect(report.totalInvocations).toBe(3);
    expect(report.maxCallDepth).toBe(2);
    expect(report.details).toContain('verified clean');
  });

  it('detects re-entrancy when a contract is re-invoked across external contract branches', () => {
    // Classic re-entrancy attack pattern:
    // ContractA::withdraw -> ContractB::on_payout -> ContractA::withdraw (re-entered!)
    const root: SorobanInvocationNode = {
      contractId: 'ContractA_Vault',
      functionName: 'withdraw',
      args: ['user1', 500],
      subInvocations: [
        {
          contractId: 'ContractB_Attacker',
          functionName: 'on_payout',
          args: [500],
          subInvocations: [
            {
              contractId: 'ContractA_Vault',
              functionName: 'withdraw', // Reentrant call to Vault!
              args: ['user1', 500],
              subInvocations: [],
            },
          ],
        },
      ],
    };

    const report = sentinel.analyzeInvocationTree(root, 'tx_reentrancy_exploit');

    expect(report.hasReentrancy).toBe(true);
    expect(report.riskLevel).toBe('CRITICAL');
    expect(report.incidents.length).toBe(1);

    const incident = report.incidents[0];
    expect(incident.contractId).toBe('ContractA_Vault');
    expect(incident.reentrantFunction).toBe('withdraw');
    expect(incident.initialDepth).toBe(0);
    expect(incident.reentrantDepth).toBe(2);
    expect(incident.intermediateContracts).toEqual(['ContractB_Attacker']);
    expect(incident.callPath).toEqual([
      'ContractA_Vault::withdraw',
      'ContractB_Attacker::on_payout',
      'ContractA_Vault::withdraw',
    ]);
    expect(incident.parameters).toEqual(['user1', 500]);
  });

  it('does not flag adjacent internal calls within the same contract as re-entrancy', () => {
    // ContractA::foo -> ContractA::bar (internal subroutine within same contract)
    const root: SorobanInvocationNode = {
      contractId: 'ContractA',
      functionName: 'foo',
      subInvocations: [
        {
          contractId: 'ContractA',
          functionName: 'bar',
          subInvocations: [],
        },
      ],
    };

    const report = sentinel.analyzeInvocationTree(root, 'tx_internal_call');
    expect(report.hasReentrancy).toBe(false);
    expect(report.incidents.length).toBe(0);
  });

  it('correctly parses linear depth-annotated execution traces', () => {
    const trace = [
      { depth: 0, contractId: 'ContractX', functionName: 'entry' },
      { depth: 1, contractId: 'ContractY', functionName: 'delegate' },
      { depth: 2, contractId: 'ContractX', functionName: 'reenter' },
    ];

    const report = sentinel.analyzeExecutionTrace(trace, 'tx_from_trace');
    expect(report.hasReentrancy).toBe(true);
    expect(report.incidents[0].contractId).toBe('ContractX');
    expect(report.incidents[0].intermediateContracts).toEqual(['ContractY']);
  });

  it('publishes reentrancy alert without throwing', async () => {
    const mockReport = sentinel.analyzeInvocationTree(
      {
        contractId: 'Vault',
        functionName: 'claim',
        subInvocations: [
          {
            contractId: 'Malicious',
            functionName: 'hook',
            subInvocations: [{ contractId: 'Vault', functionName: 'claim' }],
          },
        ],
      },
      'tx_mock',
    );

    await expect(reentrancySentinel.publishReentrancyAlert(mockReport)).resolves.not.toThrow();
  });
});
