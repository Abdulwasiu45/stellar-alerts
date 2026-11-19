import { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticateHook } from '../../middleware/auth.middleware';
import { env } from '../../config/env';
import { AuthenticationError, AuthorizationError } from '../../lib/errors';
import { dlqController } from './dlq.controller';
import { healthController } from './health.controller';

function parseCsvSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function requireAdminHook(request: FastifyRequest): Promise<void> {
  if (!request.user) {
    throw new AuthenticationError('Authentication required', 'AUTH_REQUIRED');
  }

  const allowedIds = parseCsvSet(env.ADMIN_USER_IDS);
  const allowedEmails = parseCsvSet(env.ADMIN_EMAILS);
  const userId = request.user.id?.toLowerCase();
  const email = request.user.email?.toLowerCase();

  const isAdmin =
    (Boolean(userId) && allowedIds.has(userId)) ||
    (Boolean(email) && allowedEmails.has(email));

  if (!isAdmin) {
    throw new AuthorizationError('Administrator privileges required', 'ADMIN_REQUIRED');
  }
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateHook);
  app.addHook('preHandler', requireAdminHook);

  app.get('/admin/dlq', dlqController.inspect.bind(dlqController));
  app.post('/admin/dlq/replay', dlqController.replay.bind(dlqController));
  app.post('/admin/dlq/purge', dlqController.purge.bind(dlqController));
  app.get('/admin/health/db', healthController.dbhealth);
}
