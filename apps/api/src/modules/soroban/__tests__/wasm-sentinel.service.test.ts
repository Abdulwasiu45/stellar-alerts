import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  WasmAuditSentinel,
  wasmAuditSentinel,
  DEFAULT_VERIFIED_AUDIT_REGISTRY,
} from '../wasm-sentinel.service';
import { runWasmAuditPass } from '../../../workers/wasm-sentinel.worker';

describe('WasmAuditSentinel & Bytecode Disassembler (#898)', () => {
  let sentinel: WasmAuditSentinel;

  // Build a valid compiled WebAssembly binary fixture with exported functions: 'transfer' and 'balance'
  // Magic: 0x00, 0x61, 0x73, 0x6d, version: 1
  const createSampleWasmBinary = (): Buffer => {
    const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    const typeContent = [
      0x02,
      0x60, 0x02, 0x7f, 0x7e, 0x01, 0x7f,
      0x60, 0x01, 0x7f, 0x01, 0x7e,
    ];
    const typeSec = [0x01, typeContent.length, ...typeContent];
    const funcContent = [0x02, 0x00, 0x01];
    const funcSec = [0x03, funcContent.length, ...funcContent];
    const exportContent = [
      0x02,
      0x08, ...Buffer.from('transfer'), 0x00, 0x00,
      0x07, ...Buffer.from('balance'), 0x00, 0x01,
    ];
    const exportSec = [0x07, exportContent.length, ...exportContent];
    const codeContent = [
      0x02,
      0x04, 0x00, 0x41, 0x00, 0x0b,
      0x04, 0x00, 0x42, 0x00, 0x0b,
    ];
    const codeSec = [0x0a, codeContent.length, ...codeContent];

    return Buffer.from([...magic, ...typeSec, ...funcSec, ...exportSec, ...codeSec]);
  };

  beforeEach(() => {
    sentinel = new WasmAuditSentinel();
  });

  describe('WASM Bytecode Parser and Disassembler', () => {
    it('parses exported function names and signatures from WASM module headers', () => {
      const sampleWasm = createSampleWasmBinary();
      const exports = sentinel.parseExportedFunctions(sampleWasm);

      expect(exports.length).toBeGreaterThanOrEqual(2);

      const transferExport = exports.find((e) => e.name === 'transfer');
      expect(transferExport).toBeDefined();
      expect(transferExport?.kind).toBe('function');
      expect(transferExport?.signature).toBe('(i32, i64) -> (i32)');
      expect(transferExport?.paramTypes).toEqual(['i32', 'i64']);
      expect(transferExport?.returnTypes).toEqual(['i32']);

      const balanceExport = exports.find((e) => e.name === 'balance');
      expect(balanceExport).toBeDefined();
      expect(balanceExport?.signature).toBe('(i32) -> (i64)');
      expect(balanceExport?.paramTypes).toEqual(['i32']);
      expect(balanceExport?.returnTypes).toEqual(['i64']);
    });

    it('returns empty array when buffer is not valid WebAssembly', () => {
      const invalidBuffer = Buffer.from('NOT_A_VALID_WASM_BINARY');
      const exports = sentinel.parseExportedFunctions(invalidBuffer);
      expect(exports).toEqual([]);
    });
  });

  describe('SHA-256 Hash Computation', () => {
    it('computes SHA-256 hash matching Stellar RPC contract code hash algorithm', () => {
      const wasmBinary = createSampleWasmBinary();
      const computedHash = sentinel.computeWasmHash(wasmBinary);

      // Verify exact canonical SHA-256
      const expectedSha256 = crypto.createHash('sha256').update(wasmBinary).digest('hex');
      expect(computedHash).toBe(expectedSha256);
      expect(computedHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('Audit Registry Cross-Referencing & Flagging', () => {
    it('flags unverified bytecode when SHA-256 hash is not in registry', async () => {
      const unverifiedWasm = createSampleWasmBinary();
      const contractId = 'C_UNVERIFIED_CONTRACT_123';

      const result = await sentinel.verifyBytecode(contractId, unverifiedWasm);

      expect(result.contractId).toBe(contractId);
      expect(result.isVerified).toBe(false);
      expect(result.warningAlert).toBeDefined();
      expect(result.warningAlert?.type).toBe('UNVERIFIED_BYTECODE_WARNING');
      expect(result.warningAlert?.severity).toBe('WARNING');
      expect(result.warningAlert?.message).toContain('is NOT verified in any known audit registry');
      expect(result.exportedFunctions.map((f) => f.name)).toContain('transfer');
    });

    it('verifies bytecode and attaches audit report when hash matches known registry', async () => {
      const knownHash = '55aaee782498db2579bcfad613a48e718bc8942df52acde232c45e8f4c284489';
      const contractId = 'C_BLEND_POOL_CONTRACT';

      // Register or verify built-in
      const isKnown = sentinel.isHashVerified(knownHash);
      expect(isKnown).toBe(true);

      const verifiedInfo = sentinel.getVerifiedInfo(knownHash);
      expect(verifiedInfo?.protocol).toBe('Blend Protocol Lending Pool');
      expect(verifiedInfo?.auditor).toContain('Certora');

      // Create a mock buffer whose hash equals knownHash via stub
      sentinel.registerVerifiedBuild('mock_known_hash_123', {
        protocol: 'Verified Token Standard',
        auditor: 'Trail of Bits',
        auditReportUrl: 'https://security.example.com/audit.pdf',
      });

      const mockBuffer = Buffer.from('test_verified_bytecode');
      const hash = sentinel.computeWasmHash(mockBuffer);
      sentinel.registerVerifiedBuild(hash, {
        protocol: 'Test Protocol',
        auditor: 'Security Auditor Co',
        auditReportUrl: 'https://audits.example.com/report.pdf',
      });

      const result = await sentinel.verifyBytecode(contractId, mockBuffer);
      expect(result.isVerified).toBe(true);
      expect(result.warningAlert).toBeUndefined();
      expect(result.verifiedInfo?.protocol).toBe('Test Protocol');
      expect(result.verifiedInfo?.auditor).toBe('Security Auditor Co');
    });
  });

  describe('Wasm Sentinel Worker Integration', () => {
    it('runs audit pass across contracts and notifies on unverified bytecode', async () => {
      const sampleWasm = createSampleWasmBinary();
      const auditedResults: any[] = [];

      const results = await runWasmAuditPass({
        sentinel,
        contractIds: ['C_SUSPICIOUS_CONTRACT'],
        fetchBytecode: async () => sampleWasm,
        notify: (res) => {
          auditedResults.push(res);
        },
      });

      expect(results).toHaveLength(1);
      expect(results[0].contractId).toBe('C_SUSPICIOUS_CONTRACT');
      expect(results[0].isVerified).toBe(false);
      expect(results[0].warningAlert).toBeDefined();
      expect(auditedResults).toHaveLength(1);
    });
  });
});
