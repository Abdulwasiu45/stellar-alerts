import { describe, it, expect, vi } from 'vitest';
import { RevertAnalyzer, revertAnalyzer } from '../revert-analyzer';

describe('RevertAnalyzer', () => {
  const analyzer = new RevertAnalyzer();

  it('analyzes structured raw revert object and extracts error code and reason', () => {
    const rawMeta = {
      errorCode: 404,
      errorType: 'ContractError',
      revertReason: 'ResourceNotFound: pool liquidity balance insufficient',
      failedContractId: 'CCONTRACT_ABC_123',
      subContractCallTree: ['CCONTRACT_ROUTER', 'CCONTRACT_ABC_123'],
      diagnosticEvents: [
        '[CCONTRACT_ROUTER] Topics: [swap] Data: 1000',
        '[CCONTRACT_ABC_123] Topics: [error, panic] Data: InsufficientLiquidity',
      ],
    };

    const result = analyzer.analyzeTransactionMeta(rawMeta, 'tx_hash_1');

    expect(result).not.toBeNull();
    expect(result?.txHash).toBe('tx_hash_1');
    expect(result?.errorCode).toBe(404);
    expect(result?.errorType).toBe('ContractError');
    expect(result?.failedContractId).toBe('CCONTRACT_ABC_123');
    expect(result?.subContractCallTree).toEqual(['CCONTRACT_ROUTER', 'CCONTRACT_ABC_123']);
    expect(result?.diagnosticEvents.length).toBe(2);
    expect(result?.suggestedRemediation).toContain('sufficient token balance');
  });

  it('derives accurate remediation recommendations based on error types and messages', () => {
    // Authorization error
    const authRemediation = analyzer.deriveRemediation('AuthorizationError', null, 'require_auth failed for user');
    expect(authRemediation).toContain('signatures');

    // Slippage error
    const slippageRemediation = analyzer.deriveRemediation('ContractError', 101, 'slippage exceeded minimum amount');
    expect(slippageRemediation).toContain('slippage');

    // Deadline expired
    const deadlineRemediation = analyzer.deriveRemediation('ContractError', 102, 'deadline expired');
    expect(deadlineRemediation).toContain('deadline');

    // Storage error
    const storageRemediation = analyzer.deriveRemediation('StorageError', 'STORAGE_ERR', 'ttl archived');
    expect(storageRemediation).toContain('restore entry TTL');

    // Wasm trap
    const wasmRemediation = analyzer.deriveRemediation('WasmTrap', 'WASM_TRAP', 'unreachable instruction');
    expect(wasmRemediation).toContain('WebAssembly trap');
  });

  it('identifies sub-contract in call tree from diagnostic events', () => {
    const mockMeta = {
      v3: () => ({
        sorobanMeta: () => ({
          returnValue: () => ({
            switch: () => ({ name: 'scvError' }),
            error: () => ({
              switch: () => ({ name: 'sceContract' }),
              contractCode: () => 1005,
            }),
          }),
          diagnosticEvents: () => [
            {
              event: () => ({
                contractId: () => Buffer.from('11111111111111111111111111111111'),
                body: () => ({
                  value: () => ({
                    topics: () => [
                      {
                        switch: () => ({ name: 'scvSymbol' }),
                        value: () => Buffer.from('entry_call'),
                      },
                    ],
                    data: () => ({
                      switch: () => ({ name: 'scvSymbol' }),
                      value: () => Buffer.from('success'),
                    }),
                  }),
                }),
              }),
            },
            {
              event: () => ({
                contractId: () => Buffer.from('22222222222222222222222222222222'),
                body: () => ({
                  value: () => ({
                    topics: () => [
                      {
                        switch: () => ({ name: 'scvSymbol' }),
                        value: () => Buffer.from('panic_error'),
                      },
                    ],
                    data: () => ({
                      switch: () => ({ name: 'scvSymbol' }),
                      value: () => Buffer.from('Fail: slippage error'),
                    }),
                  }),
                }),
              }),
            },
          ],
        }),
      }),
    };

    const analysis = analyzer.analyzeTransactionMeta(mockMeta as any, 'tx_with_xdr_meta');
    expect(analysis).not.toBeNull();
    expect(analysis?.errorCode).toBe(1005);
    expect(analysis?.errorType).toBe('ContractError');
    expect(analysis?.diagnosticEvents.length).toBe(2);
    expect(analysis?.subContractCallTree.length).toBe(2);
  });

  it('publishes revert alert without throwing', async () => {
    const analysis = {
      txHash: '0xabc123',
      failedContractId: 'CCONTRACT_ABC',
      subContractCallTree: ['CCONTRACT_ABC'],
      errorCode: 99,
      errorType: 'ContractError' as const,
      revertReason: 'Execution reverted',
      diagnosticEvents: ['Event 1'],
      suggestedRemediation: 'Check parameters',
      timestamp: new Date().toISOString(),
    };

    await expect(revertAnalyzer.publishRevertAlert(analysis)).resolves.not.toThrow();
  });
});
