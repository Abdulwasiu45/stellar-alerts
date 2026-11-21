import { z } from 'zod';
import { isValidEd25519PublicKey } from '../strkey';

/** A classic Stellar account id (`G...`, Ed25519 public key with a valid checksum). */
export const stellarAccountIdSchema = z
  .string()
  .refine((value) => isValidEd25519PublicKey(value), 'Must be a valid Stellar public key (G...)');

// ── SEP-0010 Web Authentication ──────────────────────────────────────────────

/** GET /auth/sep10/challenge — `account` is the SEP-10 name, `publicKey` the legacy alias. */
export const sep10ChallengeQuerySchema = z
  .object({
    account: stellarAccountIdSchema.optional(),
    publicKey: stellarAccountIdSchema.optional(),
    /** Optional MEMO_ID (uint64) for shared / custodial accounts. */
    memo: z
      .string()
      .regex(/^\d{1,20}$/, 'memo must be an unsigned 64-bit integer')
      .optional(),
  })
  .refine((query) => Boolean(query.account || query.publicKey), {
    message: 'Missing required query parameter: "account" or "publicKey"',
    path: ['account'],
  });
export type Sep10ChallengeQuery = z.infer<typeof sep10ChallengeQuerySchema>;

export const sep10ChallengeResponseSchema = z.object({
  /** Base64 XDR of the server-signed challenge transaction envelope. */
  transaction: z.string().min(1),
  networkPassphrase: z.string().min(1),
});
export type Sep10ChallengeResponse = z.infer<typeof sep10ChallengeResponseSchema>;

/** POST /auth/sep10/verify */
export const sep10VerifyRequestSchema = z.object({
  /** Base64 XDR of the challenge after the client signed it. */
  transaction: z.string().min(1).max(16384),
});
export type Sep10VerifyRequest = z.infer<typeof sep10VerifyRequestSchema>;

export const sep10SessionResponseSchema = z.object({
  token: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    publicKey: stellarAccountIdSchema,
  }),
});
export type Sep10SessionResponse = z.infer<typeof sep10SessionResponseSchema>;
