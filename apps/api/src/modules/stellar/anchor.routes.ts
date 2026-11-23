import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';
import { authenticate } from '../../middleware/rbac.middleware';
import { prisma } from '../../lib/prisma';
import { NotFoundError, ValidationError, zodValidationError } from '../../lib/errors';
import { SsrfValidationError } from '../../utils/ssrf';
import { anchorLifecycleWatcher, unifiedAnchorState } from './anchor-watcher.service';

const registerTransferSchema = z.object({
  anchorEndpoint: z.string().url().max(2048),
  anchorTxId: z.string().min(1).max(256),
  protocol: z.enum(['sep24', 'sep31']),
  kind: z.enum(['deposit', 'withdrawal', 'payment']).optional(),
  anchorAccount: z
    .string()
    .refine((value) => isValidEd25519PublicKey(value), 'Must be a valid Stellar public key')
    .optional(),
  memo: z.string().min(1).max(64).optional(),
  memoType: z.enum(['text', 'id', 'hash']).optional(),
});

const transferParamsSchema = z.object({ id: z.string().min(1) });

function present(watch: any) {
  return {
    ...watch,
    unifiedState: watch.unifiedState ?? (watch.lastKnownStatus ? unifiedAnchorState(watch.lastKnownStatus) : null),
  };
}

async function findOwnedTransfer(request: FastifyRequest, include?: Record<string, unknown>) {
  const parsed = transferParamsSchema.safeParse(request.params);
  if (!parsed.success) throw zodValidationError(parsed, 'Invalid parameters');

  const watch = await prisma.anchorTransactionWatch.findFirst({
    where: { id: parsed.data.id, userId: (request as any).user.id },
    ...(include ? { include } : {}),
  });
  if (!watch) throw new NotFoundError('Anchor transfer not found');
  return watch;
}

/**
 * SEP-24 / SEP-31 anchor transfer tracking. Register an anchor transaction id
 * (plus, optionally, the anchor account and memo of its on-chain leg) and the
 * watcher keeps its unified lifecycle state and matching Stellar transaction up
 * to date.
 */
export async function anchorRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.post('/anchor/transfers', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = registerTransferSchema.safeParse(request.body);
    if (!parsed.success) throw zodValidationError(parsed, 'Invalid anchor transfer');

    try {
      const transfer = await anchorLifecycleWatcher.register((request as any).user.id, parsed.data);
      return reply.status(201).send({ success: true, transfer: present(transfer) });
    } catch (err) {
      if (err instanceof SsrfValidationError) {
        throw new ValidationError('Anchor endpoint is not allowed', undefined, 'INVALID_ANCHOR_ENDPOINT');
      }
      throw err;
    }
  });

  app.get('/anchor/transfers', async (request: FastifyRequest, reply: FastifyReply) => {
    const transfers = await prisma.anchorTransactionWatch.findMany({
      where: { userId: (request as any).user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return reply.send({ success: true, transfers: transfers.map(present) });
  });

  app.get('/anchor/transfers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const transfer = await findOwnedTransfer(request, { events: { orderBy: { createdAt: 'asc' } } });
    return reply.send({ success: true, transfer: present(transfer) });
  });

  app.delete('/anchor/transfers/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const transfer = await findOwnedTransfer(request);
    await prisma.anchorTransactionWatch.delete({ where: { id: transfer.id } });
    return reply.send({ success: true });
  });
}
