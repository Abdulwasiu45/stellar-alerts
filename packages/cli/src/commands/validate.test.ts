import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import * as StellarSdk from 'stellar-sdk';
import { classifyStrKey, formatValidateResult, registerValidateCommand } from './validate.js';

// Public SEP-23 / StrKey test vectors (same ones as packages/shared/src/strkey.test.ts).
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const SEP23_ACCOUNT = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const SEP23_MUXED = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';
const CONTRACT_ID = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';

/** Same length and alphabet, different final character: only the checksum breaks. */
function corruptLastChar(key: string): string {
  return key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
}

function run(key: string) {
  const program = new Command();
  registerValidateCommand(program);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  program.parse(['node', 'stellar-alerts-cli', 'validate', key]);
  const output = [...log.mock.calls, ...error.mock.calls].flat().join('\n');
  return { exit, output };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('classifyStrKey', () => {
  it('accepts an account key and returns its 32-byte payload', () => {
    const result = classifyStrKey(NULL_ACCOUNT);
    expect(result).toMatchObject({ valid: true, type: 'account', payloadHex: '00'.repeat(32) });

    const sep23 = classifyStrKey(SEP23_ACCOUNT);
    expect(sep23.valid && sep23.payloadHex).toBe(
      StellarSdk.StrKey.decodeEd25519PublicKey(SEP23_ACCOUNT).toString('hex'),
    );
  });

  it('accepts a contract id', () => {
    const result = classifyStrKey(CONTRACT_ID);
    expect(result).toMatchObject({ valid: true, type: 'contract' });
    expect(result.valid && result.payloadHex).toHaveLength(64);
  });

  it('accepts a muxed address and splits out the base account and mux id', () => {
    const result = classifyStrKey(SEP23_MUXED);
    expect(result).toMatchObject({
      valid: true,
      type: 'muxed',
      muxed: { accountId: SEP23_ACCOUNT, id: '9223372036854775808' },
    });
    expect(result.valid && result.payloadHex).toHaveLength(80);
  });

  it('accepts a pre-authorized transaction key', () => {
    const key = StellarSdk.StrKey.encodePreAuthTx(Buffer.alloc(32, 0xab));
    expect(classifyStrKey(key)).toMatchObject({ valid: true, type: 'preAuthTx', payloadHex: 'ab'.repeat(32) });
  });

  it.each([
    ['account', NULL_ACCOUNT],
    ['contract', CONTRACT_ID],
    ['muxed', SEP23_MUXED],
    ['pre-auth tx', StellarSdk.StrKey.encodePreAuthTx(Buffer.alloc(32, 0xab))],
  ])('rejects a %s key with a corrupted checksum', (_name, key) => {
    expect(classifyStrKey(corruptLastChar(key))).toEqual({
      valid: false,
      reason: 'checksum mismatch, the key was probably mistyped',
    });
  });

  it('rejects an unknown prefix, a truncated key, bad characters and empty input', () => {
    expect(classifyStrKey('X' + NULL_ACCOUNT.slice(1))).toMatchObject({
      valid: false,
      reason: expect.stringContaining('unknown prefix "X"'),
    });
    expect(classifyStrKey(NULL_ACCOUNT.slice(0, -1))).toMatchObject({
      valid: false,
      reason: expect.stringContaining('expected 56 characters, got 55'),
    });
    expect(classifyStrKey(NULL_ACCOUNT.slice(0, -1) + '1')).toMatchObject({
      valid: false,
      reason: expect.stringContaining('StrKey alphabet'),
    });
    expect(classifyStrKey('')).toEqual({ valid: false, reason: 'empty input' });
  });

  it('rejects a secret seed without echoing it', () => {
    const seed = StellarSdk.StrKey.encodeEd25519SecretSeed(Buffer.alloc(32, 7));
    const result = classifyStrKey(seed);
    expect(result).toMatchObject({ valid: false, reason: expect.stringContaining('secret seed') });
    expect(formatValidateResult(result)).not.toContain(seed);
  });
});

describe('validate command', () => {
  it('prints type and payload and exits 0 for a valid key', () => {
    const { exit, output } = run(SEP23_MUXED);
    expect(exit).not.toHaveBeenCalled();
    expect(output).toContain('Valid Muxed account');
    expect(output).toContain(SEP23_ACCOUNT);
    expect(output).toContain('9223372036854775808');
  });

  it('prints the reason and exits 1 for a corrupted checksum', () => {
    const { exit, output } = run(corruptLastChar(NULL_ACCOUNT));
    expect(exit).toHaveBeenCalledWith(1);
    expect(output).toContain('checksum mismatch');
  });

  it('exits 1 for a secret seed and never prints it', () => {
    const seed = StellarSdk.StrKey.encodeEd25519SecretSeed(Buffer.alloc(32, 7));
    const { exit, output } = run(seed);
    expect(exit).toHaveBeenCalledWith(1);
    expect(output).not.toContain(seed);
  });
});
