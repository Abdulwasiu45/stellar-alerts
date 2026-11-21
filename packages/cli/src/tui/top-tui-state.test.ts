import { describe, expect, it } from 'vitest';
import {
  topTuiReducer,
  initialTopTuiState,
  currentTps,
  renderSparkline,
  TPS_WINDOW_SECONDS,
  type TopTuiState,
} from './top-tui-state.js';
import { PaymentDTO } from '../lib/types.js';

function payment(overrides: Partial<PaymentDTO> = {}): PaymentDTO {
  return {
    id: 'payment-1',
    walletId: 'wallet-1',
    txHash: 'tx-1',
    fromAddress: 'GABCDEFGHIJKLMN',
    amount: '100.5',
    asset: 'XLM',
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('topTuiReducer (#944)', () => {
  describe('ADD_PAYMENT', () => {
    it('adds the payment to the front of the recent list and increments the total', () => {
      const state = initialTopTuiState();
      const next = topTuiReducer(state, { type: 'ADD_PAYMENT', payload: payment(), nowMs: 1_000_000 });

      expect(next.payments).toHaveLength(1);
      expect(next.totalReceived).toBe(1);
    });

    it('caps the recent payments list at 50', () => {
      let state: TopTuiState = initialTopTuiState();
      for (let i = 0; i < 60; i += 1) {
        state = topTuiReducer(state, {
          type: 'ADD_PAYMENT',
          payload: payment({ id: `payment-${i}` }),
          nowMs: 1_000_000 + i,
        });
      }
      expect(state.payments).toHaveLength(50);
      expect(state.totalReceived).toBe(60);
    });

    it('does nothing while paused', () => {
      let state = initialTopTuiState();
      state = topTuiReducer(state, { type: 'TOGGLE_PAUSE' });
      const next = topTuiReducer(state, { type: 'ADD_PAYMENT', payload: payment(), nowMs: 1_000_000 });

      expect(next.payments).toHaveLength(0);
      expect(next.totalReceived).toBe(0);
    });

    it('accumulates multiple payments in the same second into one bucket', () => {
      let state = initialTopTuiState();
      state = topTuiReducer(state, { type: 'ADD_PAYMENT', payload: payment(), nowMs: 5_000 });
      state = topTuiReducer(state, { type: 'ADD_PAYMENT', payload: payment(), nowMs: 5_500 });
      state = topTuiReducer(state, { type: 'ADD_PAYMENT', payload: payment(), nowMs: 5_900 });

      expect(state.tpsBuckets).toHaveLength(1);
      expect(state.tpsBuckets[0]).toMatchObject({ secondEpoch: 5, count: 3 });
    });

    it('starts a new bucket for a payment in the next second', () => {
      let state = initialTopTuiState();
      state = topTuiReducer(state, { type: 'ADD_PAYMENT', payload: payment(), nowMs: 5_000 });
      state = topTuiReducer(state, { type: 'ADD_PAYMENT', payload: payment(), nowMs: 6_000 });

      expect(state.tpsBuckets).toHaveLength(2);
      expect(state.tpsBuckets.map((b) => b.secondEpoch)).toEqual([5, 6]);
    });

    it(`drops buckets older than the ${TPS_WINDOW_SECONDS}s window`, () => {
      let state = initialTopTuiState();
      state = topTuiReducer(state, { type: 'ADD_PAYMENT', payload: payment(), nowMs: 0 });
      state = topTuiReducer(state, {
        type: 'ADD_PAYMENT',
        payload: payment(),
        nowMs: (TPS_WINDOW_SECONDS + 10) * 1000,
      });

      expect(state.tpsBuckets).toHaveLength(1);
      expect(state.tpsBuckets[0].secondEpoch).toBe(TPS_WINDOW_SECONDS + 10);
    });
  });

  describe('SET_METRICS', () => {
    it('replaces the metrics snapshot', () => {
      const state = initialTopTuiState();
      const next = topTuiReducer(state, {
        type: 'SET_METRICS',
        payload: { heapUsedBytes: 1024, queueLatencyMs: 42.5 },
      });

      expect(next.metrics).toEqual({ heapUsedBytes: 1024, queueLatencyMs: 42.5 });
    });
  });

  describe('SET_CONNECTION_STATUS', () => {
    it('updates the connection status', () => {
      const state = initialTopTuiState();
      const next = topTuiReducer(state, { type: 'SET_CONNECTION_STATUS', payload: 'connected' });
      expect(next.connectionStatus).toBe('connected');
    });
  });

  describe('TOGGLE_PAUSE', () => {
    it('flips isPaused each call', () => {
      const state = initialTopTuiState();
      const once = topTuiReducer(state, { type: 'TOGGLE_PAUSE' });
      const twice = topTuiReducer(once, { type: 'TOGGLE_PAUSE' });
      expect(once.isPaused).toBe(true);
      expect(twice.isPaused).toBe(false);
    });
  });

  describe('CLEAR', () => {
    it('resets payments, total, and TPS buckets but not connection status', () => {
      let state = initialTopTuiState();
      state = topTuiReducer(state, { type: 'ADD_PAYMENT', payload: payment(), nowMs: 1000 });
      state = topTuiReducer(state, { type: 'SET_CONNECTION_STATUS', payload: 'connected' });

      const next = topTuiReducer(state, { type: 'CLEAR' });

      expect(next.payments).toHaveLength(0);
      expect(next.totalReceived).toBe(0);
      expect(next.tpsBuckets).toHaveLength(0);
      expect(next.connectionStatus).toBe('connected');
    });
  });
});

describe('currentTps (#944)', () => {
  it('returns the completed previous second bucket count', () => {
    const buckets = [{ secondEpoch: 5, count: 3 }];
    expect(currentTps(buckets, 6_500)).toBe(3);
  });

  it('returns 0 when the most recent bucket is not the second just before now', () => {
    const buckets = [{ secondEpoch: 5, count: 3 }];
    expect(currentTps(buckets, 10_000)).toBe(0);
  });

  it('returns 0 for an empty bucket list', () => {
    expect(currentTps([], 10_000)).toBe(0);
  });
});

describe('renderSparkline (#944)', () => {
  it('renders a flat line of the lowest character for an empty bucket list', () => {
    const line = renderSparkline([]);
    expect(line).toHaveLength(TPS_WINDOW_SECONDS);
    expect(new Set(line.split(''))).toEqual(new Set([' ']));
  });

  it('renders the highest character for the single max bucket', () => {
    const line = renderSparkline([{ secondEpoch: 1, count: 10 }]);
    expect(line).toBe('█');
  });

  it('scales proportionally to the maximum bucket in the series', () => {
    const line = renderSparkline([
      { secondEpoch: 1, count: 1 },
      { secondEpoch: 2, count: 10 },
    ]);
    expect(line).toHaveLength(2);
    expect(line[1]).toBe('█');
  });
});
