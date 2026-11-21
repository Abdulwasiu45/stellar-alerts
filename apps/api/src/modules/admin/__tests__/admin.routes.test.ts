import Fastify, { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queue: {
    retryDlqJobs: vi.fn(),
    purgeDlqJobs: vi.fn(),
  },
  dlqReplayService: {
    inspectDlq: vi.fn(),
    replayJobs: vi.fn(),
    purgeJobs: vi.fn(),
  },
  healthController: {
    dbhealth: vi.fn(async (_req: any, reply: any) => reply.send({ ok: 'dbhealth' })),
  },
}));

vi.mock('../../../config/env', () => ({
  env: { ADMIN_USER_IDS: 'admin-1', ADMIN_EMAILS: 'root@example.com' },
}));

vi.mock('../../../middleware/auth.middleware', () => ({
  authenticateHook: async (request: any, reply: any) => {
    const userId = request.headers['x-test-user'];
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    }
    request.user = { id: userId, email: `${userId}@example.com` };
  },
}));

vi.mock('../../../lib/queue', () => mocks.queue);
vi.mock('../dlq-replay.service', () => ({ dlqReplayService: mocks.dlqReplayService }));
vi.mock('../health.controller', () => ({ healthController: mocks.healthController }));

import { adminRoutes } from '../admin.routes';

describe('admin DLQ routes (#888)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.queue.retryDlqJobs.mockResolvedValue({ success: true, retriedCount: 1, failedCount: 0 });
    mocks.queue.purgeDlqJobs.mockResolvedValue({ success: true, purgedCount: 2 });
    app = Fastify();
    await app.register(adminRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it.each([
    ['POST', '/admin/dlq/retry'],
    ['DELETE', '/admin/dlq/purge?olderThanDays=7'],
  ] as const)('%s %s requires authentication', async (method, url) => {
    const res = await app.inject({ method, url });

    expect(res.statusCode).toBe(401);
    expect(mocks.queue.retryDlqJobs).not.toHaveBeenCalled();
    expect(mocks.queue.purgeDlqJobs).not.toHaveBeenCalled();
  });

  it('rejects authenticated non-admin users', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/dlq/retry',
      headers: { 'x-test-user': 'regular-user' },
      payload: { ids: ['job-1'] },
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.queue.retryDlqJobs).not.toHaveBeenCalled();
  });

  it('lets an admin retry selected jobs back to the active queue', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/dlq/retry',
      headers: { 'x-test-user': 'admin-1' },
      payload: { ids: ['job-1'] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, retriedCount: 1, failedCount: 0 });
    expect(mocks.queue.retryDlqJobs).toHaveBeenCalledWith({ ids: ['job-1'] });
  });

  it('lets an admin purge a date range', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/dlq/purge?olderThanDays=7',
      headers: { 'x-test-user': 'admin-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, purgedCount: 2 });
    expect(mocks.queue.purgeDlqJobs).toHaveBeenCalledWith({
      olderThanDays: 7,
      limit: undefined,
      after: undefined,
      before: undefined,
    });
  });

  it('keeps the legacy database purge endpoint', async () => {
    mocks.dlqReplayService.purgeJobs.mockResolvedValue({ success: true, purgedCount: 3 });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/dlq/purge',
      headers: { 'x-test-user': 'admin-1' },
      payload: { olderThanDays: 30 },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.dlqReplayService.purgeJobs).toHaveBeenCalledWith({
      olderThanDays: 30,
      actorUserId: 'admin-1',
    });
  });
});
