import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { redis } from '../lib/redis';
import { verifyToken, UserPayload } from '../utils/jwt';
import { REALTIME_CHANNELS, RealtimeEnvelope } from '../lib/realtime';
import { ClientRegistry, WebSocketMessage } from '../lib/clientRegistry';
import { WsAuthManager, WsAuthEntry } from '../lib/ws-auth-manager';
import { authenticateHook } from '../middleware/auth.middleware';

export type { WebSocketMessage } from '../lib/clientRegistry';

declare module 'fastify' {
  interface FastifyInstance {
    broadcastToUser: (userId: string, message: WebSocketMessage) => void;
  }
}

// Per-user SSE connections (tenant-isolated, authenticated)
const sseClientsByUser = new Map<string, Set<FastifyReply>>();

export default fp(async (server: FastifyInstance) => {
  await server.register(websocket);

  const registry = new ClientRegistry();
  const authManager = new WsAuthManager();

  const subscriber =
    typeof (redis as { duplicate?: unknown })?.duplicate === 'function'
      ? redis.duplicate()
      : null;

  if (subscriber) {
    if (typeof (subscriber as { on?: unknown }).on === 'function') {
      subscriber.on('error', () => {
        // Handled via lifecycle / connect catch so offline test runs stay quiet
      });
    }

    try {
      await subscriber.connect();
      server.log.info('🔌 Redis subscriber connected for WebSocket');

      const channels = [REALTIME_CHANNELS.PAYMENTS, REALTIME_CHANNELS.DELIVERIES];
      await subscriber.subscribe(...channels, (err) => {
        if (err) {
          server.log.error({ err }, '❌ Failed to subscribe to realtime channels');
        } else {
          server.log.info({ channels }, '📡 Subscribed to realtime channels');
        }
      });
    } catch (error) {
      server.log.warn({ err: error }, '⚠️ Redis subscriber connection failed, WebSocket pub/sub disabled');
    }

    subscriber.on('message', (_channel, message) => {
      try {
        const envelope = JSON.parse(message) as RealtimeEnvelope;
        if (!envelope?.userId) return;

        registry.broadcastToUser(envelope.userId, {
          type: envelope.type,
          payload: envelope.payload,
          timestamp: envelope.timestamp,
        });
      } catch (error) {
        server.log.error({ err: error }, '❌ Error processing realtime message');
      }
    });
  }

  server.decorate('broadcastToUser', (userId: string, message: WebSocketMessage) => {
    registry.broadcastToUser(userId, message);
  });

  function extractUser(request: FastifyRequest): UserPayload | null {
    let user = request.user;
    if (!user) {
      const rawAuth = request.headers?.authorization;
      const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
      const queryToken =
        request.query && typeof request.query === 'object'
          ? (request.query as { token?: unknown }).token
          : undefined;
      const token =
        authHeader?.replace(/^Bearer\s+/i, '') ||
        (typeof queryToken === 'string' ? queryToken : undefined);
      if (token) {
        try {
          user = verifyToken<UserPayload>(token);
        } catch {
          return null;
        }
      }
    }
    return user ?? null;
  }

  server.get('/ws', { websocket: true }, (socket, request) => {
    const user = extractUser(request);
    if (!user) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    const userId = user.id;
    const entry = registry.register(userId, socket);
    server.log.info(
      `🔗 WebSocket client connected for user ${userId.substring(0, 8)}... (total for user: ${registry.clientCountForUser(userId)})`,
    );

    registry.sendToEntry(entry, {
      type: 'connection',
      payload: { status: 'connected' },
      timestamp: new Date().toISOString(),
    });

    const tokenExp = user.exp ?? 0;

    const authEntry: WsAuthEntry = {
      userId,
      tokenExp,
      onExpiring: () => {
        registry.sendToEntry(entry, {
          type: 'token_expiring',
          payload: {
            message: 'Your session token will expire soon. Please reauthenticate.',
            expiresAt: new Date(tokenExp * 1000).toISOString(),
          },
          timestamp: new Date().toISOString(),
        });
      },
      onExpired: () => {
        try {
          registry.sendToEntry(entry, {
            type: 'token_expired',
            payload: {
              message: 'Session token has expired. Reconnect with a fresh token.',
            },
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Best-effort
        }
        socket.close(4401, 'Token expired');
      },
    };

    authManager.track(authEntry);

    socket.on('message', (data: import('ws').RawData) => {
      try {
        const message = JSON.parse(data.toString());
        server.log.debug({ message }, '📩 Received WebSocket message');

        if (message?.type === 'reauth' && typeof message?.token === 'string') {
          let refreshedUser: UserPayload | null = null;
          try {
            refreshedUser = verifyToken<UserPayload>(message.token);
          } catch {
            registry.sendToEntry(entry, {
              type: 'token_expired',
              payload: { message: 'Provided token is invalid or expired.' },
              timestamp: new Date().toISOString(),
            });
            socket.close(4401, 'Unauthorized');
            return;
          }

          if (refreshedUser.id !== userId) {
            socket.close(4401, 'Unauthorized');
            return;
          }

          authManager.untrack(authEntry);
          authEntry.tokenExp = refreshedUser.exp ?? 0;
          authManager.track(authEntry);

          const restoredTopics = Array.from(entry.subscriptions);

          registry.sendToEntry(entry, {
            type: 'connection',
            payload: {
              status: 'reauthenticated',
              restoredSubscriptions: restoredTopics,
            },
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (message?.type === 'subscribe' && typeof message?.topic === 'string') {
          registry.subscribe(entry, message.topic);
          return;
        }

        if (message?.type === 'unsubscribe' && typeof message?.topic === 'string') {
          registry.unsubscribe(entry, message.topic);
          return;
        }
      } catch (error: unknown) {
        server.log.warn({ err: error }, '⚠️ Invalid WebSocket message');
      }
    });

    socket.on('close', () => {
      authManager.untrack(authEntry);
      registry.unregister(userId, entry);
      server.log.info(`🔌 WebSocket client disconnected for user ${userId.substring(0, 8)}...`);
    });

    socket.on('error', (error: Error) => {
      server.log.error({ err: error }, '❌ WebSocket error');
      authManager.untrack(authEntry);
      registry.unregister(userId, entry);
    });
  });

  server.addHook('onClose', async () => {
    for (const entry of registry.getAllEntries()) {
      try {
        (entry.socket as unknown as import('ws').WebSocket).close();
      } catch {}
    }

    if (subscriber && typeof subscriber.quit === 'function') {
      await subscriber.quit().catch(() => {});
    }
    server.log.info('🔌 WebSocket and Redis subscriber cleaned up');
  });
});

/**
 * Registers authenticated, tenant-isolated GET /events SSE endpoint.
 */
export async function registerSSEPushPlugin(app: FastifyInstance): Promise<void> {
  app.get(
    '/events',
    {
      preHandler: [authenticateHook],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.id;
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.write('event: connected\ndata: {"status":"connected"}\n\n');

      let userClients = sseClientsByUser.get(userId);
      if (!userClients) {
        userClients = new Set();
        sseClientsByUser.set(userId, userClients);
      }
      userClients.add(reply);

      request.raw.on('close', () => {
        const set = sseClientsByUser.get(userId);
        if (set) {
          set.delete(reply);
          if (set.size === 0) {
            sseClientsByUser.delete(userId);
          }
        }
      });

      await new Promise<void>((resolve) => {
        request.raw.on('close', resolve);
      });
    },
  );
}

/**
 * Broadcasts a payment event only to authenticated SSE clients owned by `userId`.
 */
export function broadcastPaymentEvent(data: object, userId?: string): void {
  if (!userId) return;
  const userClients = sseClientsByUser.get(userId);
  if (!userClients) return;

  const message = `event: payment\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of userClients) {
    try {
      client.raw.write(message);
    } catch {
      userClients.delete(client);
    }
  }
  if (userClients.size === 0) {
    sseClientsByUser.delete(userId);
  }
}

export function getActiveClientCount(): number {
  let count = 0;
  for (const set of sseClientsByUser.values()) {
    count += set.size;
  }
  return count;
}
