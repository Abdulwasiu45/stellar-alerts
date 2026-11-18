import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import ed2curve from 'ed2curve';
import { Keypair } from 'stellar-sdk';
import {
  stellarPublicKeyToCurve25519,
  encryptPushPayload,
  tryEncryptPushPayload,
  decryptPushPayload,
} from '../push-protocol-encryption';

const RECIPIENT_SECRET = 'SCIN6L3MGZFUTIRSLDRLIJBDDYXAWQ3FNS5E3ELCJLM4OV7QABB4XODS';
const RECIPIENT_PUBLIC = 'GBJK72NPOOEOTPCEXZFOIDWQ5JV6MRC3NXPIKF7VF2VFBGKJVH4ILTPZ';

/** The recipient's X25519 secret key, derived the same way a wallet holding
 * the Stellar secret key would derive its own decryption key. */
function recipientCurveSecretKey(): Uint8Array {
  const kp = Keypair.fromSecret(RECIPIENT_SECRET);
  const edKeyPair = nacl.sign.keyPair.fromSeed(kp.rawSecretKey());
  return ed2curve.convertSecretKey(edKeyPair.secretKey);
}

describe('stellarPublicKeyToCurve25519', () => {
  it('converts a valid Stellar public key to a 32-byte Curve25519 key', () => {
    const curveKey = stellarPublicKeyToCurve25519(RECIPIENT_PUBLIC);
    expect(curveKey).toHaveLength(32);
  });

  it('is deterministic for the same Stellar key', () => {
    const a = stellarPublicKeyToCurve25519(RECIPIENT_PUBLIC);
    const b = stellarPublicKeyToCurve25519(RECIPIENT_PUBLIC);
    expect(a).toEqual(b);
  });

  it('throws for an invalid Stellar public key', () => {
    expect(() => stellarPublicKeyToCurve25519('not-a-valid-key')).toThrow(/not a valid Stellar/);
  });

  it('throws for an Ethereum-style address', () => {
    expect(() => stellarPublicKeyToCurve25519('0x1234567890abcdef1234567890abcdef12345678')).toThrow();
  });
});

describe('encryptPushPayload / decryptPushPayload', () => {
  it('round-trips a plaintext message through encryption and decryption', () => {
    const plaintext = JSON.stringify({ paymentId: 'pay-1', amount: '100' });
    const encrypted = encryptPushPayload(plaintext, RECIPIENT_PUBLIC);

    const decrypted = decryptPushPayload(encrypted, recipientCurveSecretKey());
    expect(decrypted).toBe(plaintext);
  });

  it('produces a different ciphertext and nonce on every call (fresh ephemeral key per message)', () => {
    const plaintext = 'same message';
    const first = encryptPushPayload(plaintext, RECIPIENT_PUBLIC);
    const second = encryptPushPayload(plaintext, RECIPIENT_PUBLIC);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ephemeralPublicKey).not.toBe(second.ephemeralPublicKey);
  });

  it('fails to decrypt with the wrong recipient secret key', () => {
    const encrypted = encryptPushPayload('secret', RECIPIENT_PUBLIC);
    const wrongSecretKey = nacl.box.keyPair().secretKey;

    const decrypted = decryptPushPayload(encrypted, wrongSecretKey);
    expect(decrypted).toBeNull();
  });

  it('fails to decrypt a tampered ciphertext', () => {
    const encrypted = encryptPushPayload('secret', RECIPIENT_PUBLIC);
    const tampered = { ...encrypted, ciphertext: Buffer.from('tampered-bytes-not-valid').toString('base64') };

    const decrypted = decryptPushPayload(tampered, recipientCurveSecretKey());
    expect(decrypted).toBeNull();
  });

  it('throws when encrypting to a non-Stellar recipient address', () => {
    expect(() => encryptPushPayload('data', 'not-a-stellar-key')).toThrow();
  });
});

describe('tryEncryptPushPayload', () => {
  it('returns an encrypted payload for a valid Stellar recipient', () => {
    const result = tryEncryptPushPayload('data', RECIPIENT_PUBLIC);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('ciphertext');
  });

  it('returns null instead of throwing for a non-Stellar recipient address', () => {
    const result = tryEncryptPushPayload('data', '0x1234567890abcdef1234567890abcdef12345678');
    expect(result).toBeNull();
  });

  it('returns null for an empty string recipient', () => {
    expect(tryEncryptPushPayload('data', '')).toBeNull();
  });
});
