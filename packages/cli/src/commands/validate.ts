import { Command } from 'commander';
import chalk from 'chalk';
import * as StellarSdk from 'stellar-sdk';
import {
  parseMuxedAddress,
  validateStrKey,
  type MuxedAddressParts,
  type StellarStrKeyKind,
  type StellarValidationReason,
} from '@stellar-alerts/shared';

export type StrKeyType = 'account' | 'contract' | 'muxed' | 'preAuthTx';

export type ValidateResult =
  | {
      valid: true;
      type: StrKeyType;
      label: string;
      address: string;
      payloadHex: string;
      /** Only for muxed (`M...`) addresses. */
      muxed?: MuxedAddressParts;
    }
  | { valid: false; reason: string };

interface PrefixInfo {
  type: StrKeyType;
  label: string;
  length: number;
  /** Kind understood by the shared validator; pre-auth tx keys are not covered there. */
  kind?: StellarStrKeyKind;
  decode: (key: string) => Buffer;
}

const { StrKey } = StellarSdk;

const PREFIXES: Record<string, PrefixInfo> = {
  G: {
    type: 'account',
    label: 'Account (Ed25519 public key)',
    length: 56,
    kind: 'ed25519PublicKey',
    decode: (k) => StrKey.decodeEd25519PublicKey(k),
  },
  C: { type: 'contract', label: 'Contract', length: 56, kind: 'contractId', decode: (k) => StrKey.decodeContract(k) },
  M: {
    type: 'muxed',
    label: 'Muxed account',
    length: 69,
    kind: 'muxedAddress',
    decode: (k) => StrKey.decodeMed25519PublicKey(k),
  },
  T: {
    type: 'preAuthTx',
    label: 'Pre-authorized transaction',
    length: 56,
    decode: (k) => StrKey.decodePreAuthTx(k),
  },
};

const CHECKSUM_MISMATCH = 'checksum mismatch, the key was probably mistyped';

const REASONS: Partial<Record<StellarValidationReason, string>> = {
  invalid_base32: 'contains characters outside the StrKey alphabet (A-Z, 2-7)',
  wrong_version_byte: 'the version byte does not match the prefix',
  invalid_checksum: CHECKSUM_MISMATCH,
};

/** Offline check of a StrKey's encoding, checksum and type. Never echoes a secret seed back. */
export function classifyStrKey(key: string): ValidateResult {
  if (key.length === 0) return { valid: false, reason: 'empty input' };
  if (key[0] === 'S') {
    return {
      valid: false,
      reason: 'this is a secret seed (S...), not an address. It was not printed; rotate it if it was shared.',
    };
  }

  const info = PREFIXES[key[0]];
  if (!info) {
    return {
      valid: false,
      reason: `unknown prefix "${key[0]}": expected G (account), C (contract), M (muxed) or T (pre-auth tx)`,
    };
  }
  if (key.length !== info.length) {
    return {
      valid: false,
      reason: `wrong length for ${info.label}: expected ${info.length} characters, got ${key.length}`,
    };
  }

  if (info.kind) {
    const check = validateStrKey(key, info.kind);
    if (!check.valid) return { valid: false, reason: REASONS[check.reason] ?? check.reason };
  }

  let payload: Buffer;
  try {
    payload = info.decode(key);
  } catch (err) {
    // Only reached for T keys, which the shared validator does not cover.
    const message = (err as Error).message;
    return { valid: false, reason: /checksum/i.test(message) ? CHECKSUM_MISMATCH : message };
  }

  return {
    valid: true,
    type: info.type,
    label: info.label,
    address: key,
    payloadHex: payload.toString('hex'),
    muxed: info.type === 'muxed' ? (parseMuxedAddress(key) ?? undefined) : undefined,
  };
}

export function formatValidateResult(result: ValidateResult): string {
  if (!result.valid) return chalk.red(`❌ Invalid: ${result.reason}`);

  const lines = [
    chalk.green(`✅ Valid ${result.label}`),
    `  Address      : ${result.address}`,
    `  Payload (hex): ${result.payloadHex}`,
  ];
  if (result.muxed) {
    lines.push(`  Base account : ${result.muxed.accountId}`, `  Mux ID       : ${result.muxed.id}`);
  }
  return lines.join('\n');
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Check a Stellar address (G, C, M or T StrKey) offline: encoding, checksum and type')
    .argument('<key>', 'StrKey to validate')
    .action((key: string) => {
      const result = classifyStrKey(key);
      if (result.valid) {
        console.log(formatValidateResult(result));
      } else {
        console.error(formatValidateResult(result));
        process.exit(1);
      }
    });
}
