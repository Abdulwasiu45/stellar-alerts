import Fastify from 'fastify';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  JWT_SECRET: 'test-super-secret-jwt-key-12345',
  TELEGRAM_BOT_TOKEN: 'test-telegram-token',
  ADMIN_USER_IDS: 'admin-1',
  ADMIN_EMAILS: 'admin@example.com',
}));

const dlqInspectMock = vi.hoisted(() => vi.fn(async (_req, reply) => reply.send({ items: [] })));
const dbHealthMock = vi.hoisted(() => vi.fn(async (_req, reply) => reply.send({ status: 'ok' })));
const confirmSyncMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ success: true, userId: 'user-1' }),
);

vi.mock('../config/env', () => ({
  env: mockConfig,
}));

vi.mock('../lib/tokenBlocklist', () => ({
  isTokenRevoked: vi.fn().mockResolvedValue(false),
  revokeToken: vi.fn(),
}));

vi.mock('../lib/session-manager', () => ({
  isFamilyRevoked: vi.fn().mockResolvedValue(false),
}));

vi.mock('../lib/redis', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(0),
    publish: vi.fn().mockResolvedValue(0),
    subscribe: vi.fn().mockResolvedValue(undefined),
    duplicate: vi.fn(() => ({
      on: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      quit: vi.fn(),
    })),
  },
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    notificationDelivery: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('../modules/admin/dlq.controller', () => ({
  dlqController: {
    inspect: dlqInspectMock,
    replay: vi.fn(async (_req, reply) => reply.send({ replayed: 0 })),
    purge: vi.fn(async (_req, reply) => reply.send({ purged: 0 })),
  },
}));

vi.mock('../modules/admin/health.controller', () => ({
  healthController: {
    dbhealth: dbHealthMock,
  },
}));

vi.mock('../modules/notifications/telegram-sync.service', () => ({
  telegramSyncService: {
    confirmSync: confirmSyncMock,
    getSyncStatus: vi.fn().mockResolvedValue({ linked: false }),
    generateSyncCode: vi.fn(),
    unlinkTelegram: vi.fn(),
  },
}));

import { AppError } from '../lib/errors';
import { generateSessionToken } from '../utils/jwt';
import { adminRoutes } from '../modules/admin/admin.routes';
import { auditRoutes } from '../modules/audit/audit.routes';
import { notificationsRoutes } from '../modules/notifications/notifications.routes';
import { graphqlRoutes } from '../modules/graphql/graphql.routes';

function buildTestServer() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message },
      });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: err.message } });
  });
  return app;
}

describe('Route authentication & authorization security regressions', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      JWT_SECRET: mockConfig.JWT_SECRET,
      TELEGRAM_BOT_TOKEN: mockConfig.TELEGRAM_BOT_TOKEN,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('rejects unauthenticated and non-admin access on /admin routes (fail-closed)', async () => {
    const app = buildTestServer();
    await app.register(adminRoutes);
    await app.ready();

    try {
      const unauthRes = await app.inject({ method: 'GET', url: '/admin/dlq' });
      expect(unauthRes.statusCode).toBe(401);

      const nonAdminToken = generateSessionToken({ id: 'regular-user', email: 'user@example.com' });
      const forbiddenRes = await app.inject({
        method: 'GET',
        url: '/admin/dlq',
        headers: { authorization: `Bearer ${nonAdminToken}` },
      });
      expect(forbiddenRes.statusCode).toBe(403);
      expect(forbiddenRes.json().error.code).toBe('ADMIN_REQUIRED');
      expect(dlqInspectMock).not.toHaveBeenCalled();

      const adminToken = generateSessionToken({ id: 'admin-1', email: 'admin@example.com' });
      const okRes = await app.inject({
        method: 'GET',
        url: '/admin/health/db',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(okRes.statusCode).toBe(200);
      expect(dbHealthMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('requires authentication on all /audit routes', async () => {
    const app = buildTestServer();
    await app.register(auditRoutes);
    await app.ready();

    try {
      const rootRes = await app.inject({ method: 'GET', url: '/audit/merkle-root/2026-01-01' });
      expect(rootRes.statusCode).toBe(401);

      const proofRes = await app.inject({
        method: 'GET',
        url: '/audit/proof/alert-1/2026-01-01',
      });
      expect(proofRes.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('protects Telegram sync-status with JWT auth and enforces webhook secret on confirm-sync', async () => {
    process.env.TELEGRAM_BOT_WEBHOOK_SECRET = 'expected-bot-secret';

    const app = buildTestServer();
    await app.register(notificationsRoutes);
    await app.ready();

    try {
      const statusUnauth = await app.inject({
        method: 'GET',
        url: '/notifications/telegram/sync-status/ABC123',
      });
      expect(statusUnauth.statusCode).toBe(401);

      const missingSecret = await app.inject({
        method: 'POST',
        url: '/notifications/telegram/confirm-sync',
        payload: { code: 'ABC123', telegramChatId: '999888' },
      });
      expect(missingSecret.statusCode).toBe(401);
      expect(confirmSyncMock).not.toHaveBeenCalled();

      const wrongSecret = await app.inject({
        method: 'POST',
        url: '/notifications/telegram/confirm-sync',
        headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
        payload: { code: 'ABC123', telegramChatId: '999888' },
      });
      expect(wrongSecret.statusCode).toBe(401);
      expect(confirmSyncMock).not.toHaveBeenCalled();

      const validSecret = await app.inject({
        method: 'POST',
        url: '/notifications/telegram/confirm-sync',
        headers: { 'x-telegram-bot-api-secret-token': 'expected-bot-secret' },
        payload: { code: 'ABC123', telegramChatId: '999888' },
      });
      expect(validSecret.statusCode).toBe(200);
      expect(confirmSyncMock).toHaveBeenCalledWith('ABC123', '999888');
    } finally {
      await app.close();
    }
  });

  it('requires authentication on /graphql requests', async () => {
    const app = buildTestServer();
    await app.register(graphqlRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query: '{ __typename }' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
