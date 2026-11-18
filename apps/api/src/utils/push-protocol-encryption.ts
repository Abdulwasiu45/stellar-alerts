import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { Keypair } from 'stellar-sdk';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';
// ed2curve has no published type declarations; see src/types/ed2curve.d.ts.
import ed2curve from 'ed2curve';

export interface EncryptedPushPayload {
  /** Base64-encoded NaCl box ciphertext. */
  ciphertext: string;
  /** Base64-encoded 24-byte nonce used for this box. */
  nonce: string;
  /** Base64-encoded ephemeral X25519 public key the recipient needs to open the box. */
  ephemeralPublicKey: string;
}

/**
 * Converts a Stellar account's Ed25519 public key (the G... address) to the
 * X25519 public key NaCl's box encryption needs.
 *
 * Push Protocol's own EPNS scheme encrypts to an Ethereum secp256k1 key,
 * which has no equivalent on a Stellar account; this converts the
 * recipient's existing Stellar key instead of requiring a second,
 * separately-registered encryption key, using the well-known
 * Ed25519-to-Curve25519 birational map (ed2curve, the same conversion
 * libsodium's crypto_sign_ed25519_pk_to_curve25519 implements).
 */
export function stellarPublicKeyToCurve25519(stellarPublicKey: string): Uint8Array {
  if (!isValidEd25519PublicKey(stellarPublicKey)) {
    throw new Error(`"${stellarPublicKey}" is not a valid Stellar Ed25519 public key`);
  }
  const edPublicKey = Keypair.fromPublicKey(stellarPublicKey).rawPublicKey();
  const curvePublicKey = ed2curve.convertPublicKey(edPublicKey);
  if (!curvePublicKey) {
    throw new Error(`Stellar public key ${stellarPublicKey} could not be converted to a Curve25519 key`);
  }
  return curvePublicKey;
}

/**
 * Encrypts a Push Protocol notification payload to the recipient's Stellar
 * wallet public key using an anonymous (sealed) NaCl box: a fresh ephemeral
 * X25519 keypair is generated per message, so the sender needs no private
 * key of its own and a compromised ephemeral key never exposes any other
 * message.
 */
export function encryptPushPayload(
  plaintext: string,
  recipientStellarPublicKey: string,
): EncryptedPushPayload {
  const recipientCurvePublicKey = stellarPublicKeyToCurve25519(recipientStellarPublicKey);
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes = new TextEncoder().encode(plaintext);

  const ciphertext = nacl.box(messageBytes, nonce, recipientCurvePublicKey, ephemeral.secretKey);

  return {
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
    ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
  };
}

/**
 * Same as {@link encryptPushPayload}, but returns null instead of throwing
 * when the recipient address isn't a Stellar Ed25519 public key.
 *
 * `pushChannelAddress` (the user-configurable override for the plain
 * wallet.publicKey fallback) can be set to any EPNS/Push Protocol channel
 * identifier, which is not guaranteed to be a Stellar key at all (e.g. an
 * Ethereum address, for a channel whose events originate elsewhere). This
 * encryption scheme only applies when the recipient genuinely has a
 * convertible Stellar key; callers fall back to an unencrypted payload
 * otherwise rather than failing the whole dispatch.
 */
export function tryEncryptPushPayload(
  plaintext: string,
  recipientAddress: string,
): EncryptedPushPayload | null {
  if (!isValidEd25519PublicKey(recipientAddress)) return null;
  try {
    return encryptPushPayload(plaintext, recipientAddress);
  } catch {
    return null;
  }
}

/**
 * Decrypts a payload produced by {@link encryptPushPayload}, given the
 * recipient's X25519 secret key. Exists primarily so the encryption round
 * trip itself can be tested without a second process; the actual
 * decryption happens client-side, in whatever wallet or dApp holds the
 * recipient's key.
 */
export function decryptPushPayload(
  encrypted: EncryptedPushPayload,
  recipientCurveSecretKey: Uint8Array,
): string | null {
  const ciphertext = decodeBase64(encrypted.ciphertext);
  const nonce = decodeBase64(encrypted.nonce);
  const ephemeralPublicKey = decodeBase64(encrypted.ephemeralPublicKey);

  const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientCurveSecretKey);
  if (!decrypted) return null;
  return new TextDecoder().decode(decrypted);
}
