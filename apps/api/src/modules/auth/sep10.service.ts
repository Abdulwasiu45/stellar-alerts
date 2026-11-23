import * as StellarSdk from 'stellar-sdk';
import crypto from 'crypto';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { stellarNetwork } from '../../config/network';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';

/**
 * SEP-0010 Web Authentication.
 *
 * Challenge: a server-signed transaction with sequence number 0, bounded
 * time, a `<home domain> auth` manageData operation sourced from the client
 * (carrying a 64-byte nonce) and a `web_auth_domain` operation sourced from
 * the server.
 *
 * Verification is strict: structure, server signature, time bounds, then the
 * client's signatures are weighed against the client account's real on-chain
 * signers and medium threshold. A verified challenge is single-use.
 */

export type Sep10ErrorCode =
  | 'INVALID_ACCOUNT'
  | 'INVALID_CHALLENGE'
  | 'CHALLENGE_REPLAYED'
  | 'INSUFFICIENT_SIGNER_WEIGHT'
  | 'SIGNER_LOOKUP_FAILED'
  | 'REPLAY_STORE_UNAVAILABLE';

export class Sep10Error extends Error {
  constructor(
    message: string,
    readonly code: Sep10ErrorCode,
  ) {
    super(message);
    this.name = 'Sep10Error';
  }
}

export interface SEP10ChallengeResult {
  transaction: string;
  networkPassphrase: string;
}

export interface SEP10ChallengeOptions {
  timeoutSeconds?: number;
  /** MEMO_ID (uint64) for shared / custodial accounts. */
  memo?: string;
}

export interface SEP10VerificationResult {
  valid: boolean;
  clientPublicKey: string;
  memo?: string;
}

export interface SEP10SignerVerificationResult extends SEP10VerificationResult {
  /** Signer keys whose signatures were found on the challenge. */
  signersUsed: string[];
  /** Combined weight of those signers. */
  signedWeight: number;
  /** Medium threshold the weight had to reach. */
  threshold: number;
  /** False when the client account is not funded yet (master key signs alone). */
  accountExists: boolean;
}

export interface SEP10AuthSessionResponse {
  token: string;
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    publicKey: string;
  };
}

export interface ClientAccountSigners {
  signers: Array<{ key: string; weight: number }>;
  mediumThreshold: number;
}

/** Remembers verified challenges so each can be used exactly once. */
export interface Sep10ReplayGuard {
  /** True the first time `key` is seen; false when it was already consumed. */
  consume(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface Sep10Dependencies {
  replayGuard?: Sep10ReplayGuard;
  /** Loads the client's on-chain signers; null when the account does not exist. */
  loadClientSigners?: (publicKey: string) => Promise<ClientAccountSigners | null>;
  issueSession?: (userId: string, email: string) => Promise<{ accessToken: string; refreshToken: string }>;
  webAuthDomain?: string;
}

/** Email domain of the synthetic users created for wallet-only (SEP-10) logins. */
const SEP10_USER_EMAIL_DOMAIN = '@stellar-alerts.org';
const DEFAULT_CHALLENGE_TIMEOUT_SECONDS = 300;
/** Longest challenge lifetime accepted (SEP-10 recommends 15 minutes at most). */
const MAX_CHALLENGE_LIFETIME_SECONDS = 900;
const CLOCK_SKEW_GRACE_SECONDS = 30;
const NONCE_BYTES = 64;
const WEB_AUTH_DOMAIN_KEY = 'web_auth_domain';

const insecureOfflineAllowed = () => process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';

/** Redis `SET NX EX`; fails closed outside dev/test when Redis cannot confirm. */
class RedisReplayGuard implements Sep10ReplayGuard {
  private readonly localSeen = new Map<string, number>();

  async consume(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const { redis } = await import('../../lib/redis');
      const result = await redis.set(`sep10:challenge:${key}`, '1', 'EX', Math.max(1, ttlSeconds), 'NX');
      return result === 'OK';
    } catch (err: unknown) {
      if (!insecureOfflineAllowed()) {
        throw new Sep10Error(
          `Unable to record SEP-10 challenge use: ${err instanceof Error ? err.message : String(err)}`,
          'REPLAY_STORE_UNAVAILABLE',
        );
      }
      const now = Date.now();
      for (const [seenKey, expiresAt] of this.localSeen) if (expiresAt <= now) this.localSeen.delete(seenKey);
      if (this.localSeen.has(key)) return false;
      this.localSeen.set(key, now + ttlSeconds * 1000);
      return true;
    }
  }
}

async function loadSignersFromHorizon(publicKey: string): Promise<ClientAccountSigners | null> {
  const { stellar } = await import('../../lib/stellar');
  try {
    const account = await stellar.server.loadAccount(publicKey);
    return {
      signers: account.signers.map((signer) => ({ key: signer.key, weight: Number(signer.weight) })),
      mediumThreshold: Number(account.thresholds.med_threshold),
    };
  } catch (err: any) {
    // An unfunded account is a legitimate SEP-10 client: only its master key can sign.
    if (err?.name === 'NotFoundError' || err?.response?.status === 404) return null;
    // Anything else (outage, timeout) must NOT fall back to master-key-only:
    // a rotated-away master key could then authenticate while Horizon is down.
    throw new Sep10Error(
      `Unable to load signers for the client account: ${err?.message || err}`,
      'SIGNER_LOOKUP_FAILED',
    );
  }
}

interface ParsedChallenge {
  tx: StellarSdk.Transaction;
  clientPublicKey: string;
  memo?: string;
  hashHex: string;
  maxTime: number;
}

export class SEP10Service {
  private homeDomain: string;
  private webAuthDomain: string;
  private networkPassphrase: string;
  private serverKeypair: StellarSdk.Keypair;
  private replayGuard: Sep10ReplayGuard;
  private loadClientSigners: (publicKey: string) => Promise<ClientAccountSigners | null>;
  private issueSessionFn?: Sep10Dependencies['issueSession'];

  constructor(
    serverSecret?: string,
    homeDomain?: string,
    networkPassphrase?: string,
    deps: Sep10Dependencies = {},
  ) {
    this.homeDomain = homeDomain || process.env.SEP10_HOME_DOMAIN || 'stellar-alerts.org';
    this.webAuthDomain = deps.webAuthDomain || process.env.SEP10_WEB_AUTH_DOMAIN || this.homeDomain;
    this.networkPassphrase =
      networkPassphrase || process.env.STELLAR_NETWORK_PASSPHRASE || stellarNetwork.networkPassphrase;
    this.replayGuard = deps.replayGuard ?? new RedisReplayGuard();
    this.loadClientSigners = deps.loadClientSigners ?? loadSignersFromHorizon;
    this.issueSessionFn = deps.issueSession;

    const secret = serverSecret || process.env.STELLAR_SERVER_SECRET || process.env.STELLAR_SIGNING_KEY;
    if (secret && secret.startsWith('S') && secret.length === 56) {
      this.serverKeypair = StellarSdk.Keypair.fromSecret(secret);
    } else {
      // Deterministic fallback server key derived from JWT_SECRET or default seed
      const seedMaterial = (env.JWT_SECRET || 'stellar_alerts_sep10_default_master_signing_seed_key!').padEnd(32, '0').slice(0, 32);
      const rawSeed = crypto.createHash('sha256').update(seedMaterial).digest();
      this.serverKeypair = StellarSdk.Keypair.fromRawEd25519Seed(rawSeed);
    }
  }

  public getServerPublicKey(): string {
    return this.serverKeypair.publicKey();
  }

  /**
   * Generates a valid SEP-0010 challenge transaction envelope signed by the server.
   * - Sequence number: 0 (represented as Account with sequence "-1")
   * - Source account: serverKeypair.publicKey()
   * - Time bounds: minTime = now - 30s grace, maxTime = now + timeout (default 300s)
   * - Operation 1: ManageData, source = client, name = `${homeDomain} auth`, 64-byte random nonce
   * - Operation 2: ManageData, source = server, name = `web_auth_domain`
   * - Optional MEMO_ID for shared accounts
   * - Signed by serverKeypair
   */
  public generateChallenge(
    clientPublicKey: string,
    options: number | SEP10ChallengeOptions = {},
  ): SEP10ChallengeResult {
    const { timeoutSeconds = DEFAULT_CHALLENGE_TIMEOUT_SECONDS, memo } =
      typeof options === 'number' ? { timeoutSeconds: options } : options;

    if (!clientPublicKey || !isValidEd25519PublicKey(clientPublicKey)) {
      throw new Sep10Error(`Invalid client Stellar public key: ${clientPublicKey}`, 'INVALID_ACCOUNT');
    }
    if (timeoutSeconds <= 0 || timeoutSeconds > MAX_CHALLENGE_LIFETIME_SECONDS) {
      throw new Sep10Error(
        `Challenge timeout must be between 1 and ${MAX_CHALLENGE_LIFETIME_SECONDS} seconds`,
        'INVALID_CHALLENGE',
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const minTime = Math.max(0, now - CLOCK_SKEW_GRACE_SECONDS);
    const maxTime = now + timeoutSeconds;

    // Sequence -1 produces sequence number 0 in the built transaction envelope
    const serverAccount = new StellarSdk.Account(this.serverKeypair.publicKey(), '-1');

    // 48 random bytes -> exactly 64 base64 characters (the SEP-10 nonce size).
    const nonce = crypto.randomBytes(48).toString('base64');

    const builder = new StellarSdk.TransactionBuilder(serverAccount, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
      timebounds: { minTime, maxTime },
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          source: clientPublicKey,
          name: `${this.homeDomain} auth`,
          value: Buffer.from(nonce, 'utf-8'),
        }),
      )
      .addOperation(
        StellarSdk.Operation.manageData({
          source: this.serverKeypair.publicKey(),
          name: WEB_AUTH_DOMAIN_KEY,
          value: Buffer.from(this.webAuthDomain, 'utf-8'),
        }),
      );

    if (memo !== undefined) {
      if (!/^\d{1,20}$/.test(memo)) {
        throw new Sep10Error('Challenge memo must be an unsigned 64-bit integer', 'INVALID_CHALLENGE');
      }
      builder.addMemo(StellarSdk.Memo.id(memo));
    }

    const tx = builder.build();

    // Server signs first
    tx.sign(this.serverKeypair);

    return {
      transaction: tx.toEnvelope().toXDR('base64'),
      networkPassphrase: this.networkPassphrase,
    };
  }

  /**
   * Structural + server-side validation shared by every verification path:
   * sequence 0, server source, time bounds, operations, server signature, nonce.
   * Does not look at the client's signatures.
   */
  private parseChallenge(transactionXdr: string): ParsedChallenge {
    if (!transactionXdr || typeof transactionXdr !== 'string') {
      throw new Sep10Error('Missing or invalid challenge transaction envelope XDR', 'INVALID_CHALLENGE');
    }

    let tx: StellarSdk.Transaction;
    try {
      const parsed = StellarSdk.TransactionBuilder.fromXDR(transactionXdr, this.networkPassphrase);
      if (!(parsed instanceof StellarSdk.Transaction)) {
        throw new Error('Expected standard Transaction, received FeeBumpTransaction');
      }
      tx = parsed;
    } catch (err: any) {
      throw new Sep10Error(`Failed to decode transaction XDR: ${err.message}`, 'INVALID_CHALLENGE');
    }

    // 1. Strict sequence number check: must be 0
    if (tx.sequence !== '0') {
      throw new Sep10Error(`Invalid sequence number: expected "0", got "${tx.sequence}"`, 'INVALID_CHALLENGE');
    }

    // 2. Source account must match server public key
    if (tx.source !== this.serverKeypair.publicKey()) {
      throw new Sep10Error(
        `Invalid transaction source account: expected server key "${this.serverKeypair.publicKey()}", got "${tx.source}"`,
        'INVALID_CHALLENGE',
      );
    }

    // 3. Strict time bounds check
    const now = Math.floor(Date.now() / 1000);
    if (!tx.timeBounds) {
      throw new Sep10Error('Transaction is missing time bounds', 'INVALID_CHALLENGE');
    }
    const minTime = Number(tx.timeBounds.minTime);
    const maxTime = Number(tx.timeBounds.maxTime);
    if (now < minTime) {
      throw new Sep10Error(`Challenge transaction is not yet active (current: ${now}, min: ${minTime})`, 'INVALID_CHALLENGE');
    }
    if (now > maxTime) {
      throw new Sep10Error(`Challenge transaction has expired (current: ${now}, max: ${maxTime})`, 'INVALID_CHALLENGE');
    }
    if (maxTime === 0 || maxTime - minTime > MAX_CHALLENGE_LIFETIME_SECONDS + CLOCK_SKEW_GRACE_SECONDS) {
      throw new Sep10Error('Challenge transaction time window is too long', 'INVALID_CHALLENGE');
    }

    // 4. First operation: ManageData `<home domain> auth`, sourced from the client
    if (!tx.operations || tx.operations.length === 0) {
      throw new Sep10Error('Challenge transaction has no operations', 'INVALID_CHALLENGE');
    }

    const firstOp = tx.operations[0];
    if (firstOp.type !== 'manageData') {
      throw new Sep10Error(`Invalid first operation type: expected "manageData", got "${firstOp.type}"`, 'INVALID_CHALLENGE');
    }

    const clientPublicKey = firstOp.source;
    if (!clientPublicKey || !isValidEd25519PublicKey(clientPublicKey)) {
      throw new Sep10Error('Invalid or missing client public key in challenge manageData operation source', 'INVALID_CHALLENGE');
    }
    if (clientPublicKey === this.serverKeypair.publicKey()) {
      throw new Sep10Error('Client account must not be the server account', 'INVALID_CHALLENGE');
    }

    if (firstOp.name !== `${this.homeDomain} auth`) {
      throw new Sep10Error(
        `Invalid manageData operation key: expected "${this.homeDomain} auth", got "${firstOp.name}"`,
        'INVALID_CHALLENGE',
      );
    }

    // 5. Verify server signature
    const txHash = tx.hash();
    const hasServerSignature = tx.signatures.some((sig) => {
      try {
        return this.serverKeypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });
    if (!hasServerSignature) {
      throw new Sep10Error('Challenge transaction was not signed by the server key', 'INVALID_CHALLENGE');
    }

    // 6. The nonce is 64 bytes, and nothing but the web_auth_domain operation may follow.
    if (!firstOp.value || firstOp.value.length !== NONCE_BYTES) {
      throw new Sep10Error(`Challenge nonce must be exactly ${NONCE_BYTES} bytes`, 'INVALID_CHALLENGE');
    }

    let sawWebAuthDomain = false;
    for (const op of tx.operations.slice(1)) {
      if (
        op.type === 'manageData' &&
        op.source === this.serverKeypair.publicKey() &&
        op.name === WEB_AUTH_DOMAIN_KEY &&
        !sawWebAuthDomain
      ) {
        if (!op.value || op.value.toString('utf-8') !== this.webAuthDomain) {
          throw new Sep10Error(`Invalid ${WEB_AUTH_DOMAIN_KEY}: expected "${this.webAuthDomain}"`, 'INVALID_CHALLENGE');
        }
        sawWebAuthDomain = true;
        continue;
      }
      throw new Sep10Error('Challenge transaction contains an unexpected operation', 'INVALID_CHALLENGE');
    }

    // 7. Memo, when present, must be MEMO_ID (SEP-10 shared-account convention).
    let memo: string | undefined;
    if (tx.memo.type !== 'none') {
      if (tx.memo.type !== 'id') {
        throw new Sep10Error('Challenge memo must be of type MEMO_ID', 'INVALID_CHALLENGE');
      }
      memo = String(tx.memo.value);
    }

    return { tx, clientPublicKey, memo, hashHex: txHash.toString('hex'), maxTime };
  }

  /**
   * Which of `keys` signed the challenge. Signatures from the server are
   * ignored; a signature that matches neither the server nor any of `keys`
   * is reported as unrecognized.
   */
  private matchSignatures(tx: StellarSdk.Transaction, keys: string[]) {
    const txHash = tx.hash();
    const keypairs = keys.map((key) => ({ key, keypair: StellarSdk.Keypair.fromPublicKey(key) }));
    const matched = new Set<string>();
    let unrecognized = 0;

    for (const sig of tx.signatures) {
      const signature = sig.signature();
      const isServer = (() => {
        try {
          return this.serverKeypair.verify(txHash, signature);
        } catch {
          return false;
        }
      })();
      if (isServer) continue;

      const signer = keypairs.find(({ keypair }) => {
        try {
          return keypair.verify(txHash, signature);
        } catch {
          return false;
        }
      });
      if (signer) matched.add(signer.key);
      else unrecognized += 1;
    }

    return { matched, unrecognized };
  }

  /**
   * Validates the challenge and that the client's *master key* signed it.
   * Synchronous and offline; it knows nothing about the account's on-chain
   * signers. Session issuance uses {@link verifyChallengeSigners} instead.
   */
  public verifyChallenge(transactionXdr: string): SEP10VerificationResult {
    const { tx, clientPublicKey, memo } = this.parseChallenge(transactionXdr);

    const { matched } = this.matchSignatures(tx, [clientPublicKey]);
    if (!matched.has(clientPublicKey)) {
      throw new Sep10Error(`Challenge transaction is missing a valid signature from client "${clientPublicKey}"`, 'INVALID_CHALLENGE');
    }

    return { valid: true, clientPublicKey, ...(memo ? { memo } : {}) };
  }

  /**
   * Validates the challenge against the client account's real signers: the
   * signatures present must come from the account's signers, and their
   * combined weight must reach the account's medium threshold. An unfunded
   * account can only be authenticated by its own master key.
   */
  public async verifyChallengeSigners(transactionXdr: string): Promise<SEP10SignerVerificationResult> {
    return this.verifySigners(this.parseChallenge(transactionXdr));
  }

  private async verifySigners({ tx, clientPublicKey, memo }: ParsedChallenge): Promise<SEP10SignerVerificationResult> {

    const account = await this.loadClientSigners(clientPublicKey);
    const accountExists = account !== null;
    const signers = account?.signers ?? [{ key: clientPublicKey, weight: 1 }];
    const threshold = account?.mediumThreshold ?? 0;

    // Only Ed25519 signers can sign a challenge; hash(x) / pre-auth signers are ignored.
    const weights = new Map<string, number>();
    for (const signer of signers) {
      if (signer.weight > 0 && isValidEd25519PublicKey(signer.key)) {
        weights.set(signer.key, Math.max(weights.get(signer.key) ?? 0, signer.weight));
      }
    }

    const { matched, unrecognized } = this.matchSignatures(tx, [...weights.keys()]);
    if (unrecognized > 0) {
      throw new Sep10Error('Challenge transaction has signatures that do not belong to the client account', 'INVALID_CHALLENGE');
    }
    if (matched.size === 0) {
      throw new Sep10Error(`Challenge transaction is missing a valid signature from client "${clientPublicKey}"`, 'INVALID_CHALLENGE');
    }

    const signedWeight = [...matched].reduce((total, key) => total + (weights.get(key) ?? 0), 0);
    if (signedWeight < threshold) {
      throw new Sep10Error(
        `Signing weight ${signedWeight} does not meet the account's medium threshold ${threshold}`,
        'INSUFFICIENT_SIGNER_WEIGHT',
      );
    }

    return {
      valid: true,
      clientPublicKey,
      ...(memo ? { memo } : {}),
      signersUsed: [...matched],
      signedWeight,
      threshold,
      accountExists,
    };
  }

  /**
   * Verifies the challenge (including signer weights), burns it so it can
   * never be replayed, upserts the user & wallet, and issues session tokens.
   */
  public async verifyAndIssueSession(transactionXdr: string): Promise<SEP10AuthSessionResponse> {
    const parsed = this.parseChallenge(transactionXdr);
    const { clientPublicKey, hashHex, maxTime } = parsed;
    await this.verifySigners(parsed);

    // Burn only after every signature check passed, so a stranger holding an
    // unsigned challenge cannot use up somebody else's login attempt.
    const ttlSeconds = Math.max(1, maxTime - Math.floor(Date.now() / 1000) + CLOCK_SKEW_GRACE_SECONDS);
    if (!(await this.replayGuard.consume(hashHex, ttlSeconds))) {
      throw new Sep10Error('Challenge transaction has already been used', 'CHALLENGE_REPLAYED');
    }

    // Find the active linked wallet. Only auto-login into synthetic SEP-10
    // accounts: a watch-only wallet entry must never log a stranger into
    // another user's email account.
    const wallet = await prisma.wallet.findUnique({
      where: { publicKey: clientPublicKey },
      include: { user: true },
    });

    let userId: string;
    let email: string;

    if (
      wallet &&
      wallet.user &&
      !(wallet as { deletedAt?: Date | null }).deletedAt &&
      wallet.user.email.endsWith(SEP10_USER_EMAIL_DOMAIN)
    ) {
      userId = wallet.user.id;
      email = wallet.user.email;
    } else {
      const placeholderEmail = `${clientPublicKey.substring(0, 12).toLowerCase()}${SEP10_USER_EMAIL_DOMAIN}`;
      const findPlaceholderUser = async () =>
        typeof (prisma.user as { findUnique?: unknown }).findUnique === 'function'
          ? prisma.user.findUnique({ where: { email: placeholderEmail } })
          : null;

      const existingSep10User = await findPlaceholderUser();
      if (existingSep10User) {
        userId = existingSep10User.id;
        email = existingSep10User.email;
      } else {
        try {
          const user = await prisma.user.create({
            data: {
              email: placeholderEmail,
              // The key may already belong to another user's (or a deleted) wallet row.
              ...(!wallet ? { wallets: { create: { publicKey: clientPublicKey } } } : {}),
            },
          });
          userId = user.id;
          email = user.email;
        } catch (err) {
          // Two first-time logins racing on the same key: the loser reads the winner's row.
          const winner = await findPlaceholderUser();
          if (!winner) throw err;
          userId = winner.id;
          email = winner.email;
        }
      }
    }

    // Same session issuer as the other login methods: refresh-token rotation
    // and reuse detection apply to wallet logins too.
    const issueSession =
      this.issueSessionFn ??
      (async (id: string, mail: string) => {
        const { authService } = await import('./auth.service');
        return authService.issueSession(id, mail);
      });
    const session = await issueSession(userId, email);

    return {
      token: session.accessToken,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: {
        id: userId,
        email,
        publicKey: clientPublicKey,
      },
    };
  }
}

export const sep10Service = new SEP10Service();
