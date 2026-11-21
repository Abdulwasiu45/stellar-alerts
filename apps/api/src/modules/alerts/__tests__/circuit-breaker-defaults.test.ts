import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisCircuitBreaker } from '../circuit-breaker';

const { mockRedis, store, ttls } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();

  const mockRedis = {
    get: vi.fn(async (key: string) => store.get(key) || null),
    set: vi.fn(async (key: string, val: string) => {
      store.set(key, val);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.delete(key);
      ttls.delete(key);
      return existed ? 1 : 0;
    }),
    incr: vi.fn(async (key: string) => {
      const cur = parseInt(store.get(key) || '0', 10);
      const next = cur + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      return 1;
    }),
  };

  return { mockRedis, store, ttls };
});

vi.mock('../../../lib/redis', () => ({
  redis: mockRedis,
  registerRedisCleanupTask: vi.fn(),
}));

/**
 * #941 asks specifically for: trips OPEN after 5 consecutive failures
 * within a 5-minute window, and a 15-minute cooldown before the single
 * HALF_OPEN probe. The existing circuit-breaker.test.ts (#633) always
 * constructs RedisCircuitBreaker with explicit 60/60 options, so nothing
 * actually asserted what `new RedisCircuitBreaker()` (no options, exactly
 * what dispatcher.worker.ts constructs) defaults to.
 */
describe('RedisCircuitBreaker default thresholds (#941)', () => {
  let breaker: RedisCircuitBreaker;
  const endpointId = 'webhook-defaults-test';

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    ttls.clear();
    breaker = new RedisCircuitBreaker();
  });

  it('sets a 5-minute (300s) TTL on the failure window by default', async () => {
    await breaker.recordFailure(endpointId, { statusCode: 500 });
    expect(mockRedis.expire).toHaveBeenCalledWith(`circuit_breaker:${endpointId}:failures`, 300);
  });

  it('trips to OPEN on exactly the 5th consecutive failure by default', async () => {
    for (let i = 1; i <= 4; i += 1) {
      const state = await breaker.recordFailure(endpointId, { statusCode: 500 });
      expect(state).toBe('CLOSED');
    }
    const finalState = await breaker.recordFailure(endpointId, { statusCode: 500 });
    expect(finalState).toBe('OPEN');
  });

  it('stays OPEN (blocks execution) for the full 15-minute default cooldown', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await breaker.recordFailure(endpointId, { statusCode: 500 });
    }
    expect(await breaker.getState(endpointId)).toBe('OPEN');

    // Just under 15 minutes: still OPEN.
    vi.useFakeTimers();
    const openedAt = Date.now();
    vi.setSystemTime(openedAt + 14 * 60 * 1000 + 59_000);
    expect(await breaker.getState(endpointId)).toBe('OPEN');
    expect(await breaker.canExecute(endpointId)).toBe(false);

    vi.useRealTimers();
  });

  it('transitions OPEN to HALF_OPEN once the full 15-minute cooldown has elapsed', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await breaker.recordFailure(endpointId, { statusCode: 500 });
    }

    vi.useFakeTimers();
    const openedAt = Date.now();
    vi.setSystemTime(openedAt + 15 * 60 * 1000 + 1_000);

    expect(await breaker.getState(endpointId)).toBe('HALF_OPEN');
    expect(await breaker.canExecute(endpointId)).toBe(true);

    vi.useRealTimers();
  });
});
