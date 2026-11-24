import { FastifyRequest, FastifyReply } from 'fastify';
import { sep10ChallengeQuerySchema, sep10VerifyRequestSchema } from '@stellar-alerts/shared';
import { sep10Service, Sep10Error } from './sep10.service';
import { AuthenticationError, ProviderError, ValidationError, zodValidationError } from '../../lib/errors';

/** Maps SEP-10 domain failures onto the API's standard error envelope. */
function toApiError(err: unknown): unknown {
  if (!(err instanceof Sep10Error)) return err;

  switch (err.code) {
    case 'INVALID_ACCOUNT':
      return new ValidationError(err.message, undefined, 'INVALID_ACCOUNT');
    case 'CHALLENGE_REPLAYED':
      return new AuthenticationError(err.message, 'SEP10_CHALLENGE_REPLAYED');
    case 'INSUFFICIENT_SIGNER_WEIGHT':
      return new AuthenticationError(err.message, 'SEP10_INSUFFICIENT_SIGNER_WEIGHT');
    case 'SIGNER_LOOKUP_FAILED':
    case 'REPLAY_STORE_UNAVAILABLE':
      return new ProviderError('SEP-10 verification is temporarily unavailable', err.code, 503);
    default:
      return new AuthenticationError(err.message, 'INVALID_SEP10_CHALLENGE');
  }
}

export class SEP10Controller {
  /**
   * GET /auth/sep10/challenge
   * Generates a SEP-0010 challenge transaction envelope for the given client account.
   */
  async getChallenge(request: FastifyRequest, reply: FastifyReply) {
    const parsed = sep10ChallengeQuerySchema.safeParse(request.query);
    if (!parsed.success) throw zodValidationError(parsed, 'Invalid SEP-10 challenge request');

    const { account, publicKey, memo } = parsed.data;
    try {
      const challenge = sep10Service.generateChallenge((account ?? publicKey)!, { memo });
      return reply.status(200).send(challenge);
    } catch (err) {
      throw toApiError(err);
    }
  }

  /**
   * POST /auth/sep10/verify
   * Verifies the signed challenge against the client account's signers and
   * issues session tokens. Each challenge can be redeemed once.
   */
  async verify(request: FastifyRequest, reply: FastifyReply) {
    const parsed = sep10VerifyRequestSchema.safeParse(request.body);
    if (!parsed.success) throw zodValidationError(parsed, 'Invalid SEP-10 verification request');

    try {
      const session = await sep10Service.verifyAndIssueSession(parsed.data.transaction);
      return reply.status(200).send(session);
    } catch (err) {
      throw toApiError(err);
    }
  }
}

export const sep10Controller = new SEP10Controller();
