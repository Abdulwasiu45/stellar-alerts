import { PaymentDTO } from '../lib/types.js';

/** One payment-count bucket, aligned to the second it was received in. */
export interface TpsBucket {
  secondEpoch: number;
  count: number;
}

export interface TopTuiMetrics {
  heapUsedBytes: number | null;
  queueLatencyMs: number | null;
}

export interface TopTuiState {
  payments: PaymentDTO[];
  totalReceived: number;
  tpsBuckets: TpsBucket[];
  metrics: TopTuiMetrics;
  connectionStatus: 'connected' | 'disconnected' | 'connecting';
  isPaused: boolean;
  lastUpdate: string;
}

export type TopTuiAction =
  | { type: 'ADD_PAYMENT'; payload: PaymentDTO; nowMs?: number }
  | { type: 'SET_METRICS'; payload: TopTuiMetrics }
  | { type: 'SET_CONNECTION_STATUS'; payload: TopTuiState['connectionStatus'] }
  | { type: 'TOGGLE_PAUSE' }
  | { type: 'CLEAR' };

/** How many one-second buckets the TPS sparkline keeps (60s of history). */
export const TPS_WINDOW_SECONDS = 60;
const MAX_RECENT_PAYMENTS = 50;

export function initialTopTuiState(): TopTuiState {
  return {
    payments: [],
    totalReceived: 0,
    tpsBuckets: [],
    metrics: { heapUsedBytes: null, queueLatencyMs: null },
    connectionStatus: 'connecting',
    isPaused: false,
    lastUpdate: new Date().toISOString(),
  };
}

function addToTpsBuckets(buckets: TpsBucket[], nowMs: number): TpsBucket[] {
  const secondEpoch = Math.floor(nowMs / 1000);
  const last = buckets[buckets.length - 1];

  const next = last && last.secondEpoch === secondEpoch
    ? [...buckets.slice(0, -1), { secondEpoch, count: last.count + 1 }]
    : [...buckets, { secondEpoch, count: 1 }];

  const cutoff = secondEpoch - TPS_WINDOW_SECONDS;
  return next.filter((b) => b.secondEpoch > cutoff);
}

/**
 * Pure state transition for the `top` TUI. Kept separate from ink (same
 * reasoning as stream-tui-state.ts) so the TPS bucketing and pause logic
 * can be unit tested without pulling in the React reconciler.
 */
export function topTuiReducer(state: TopTuiState, action: TopTuiAction): TopTuiState {
  switch (action.type) {
    case 'ADD_PAYMENT': {
      if (state.isPaused) return state;
      const nowMs = action.nowMs ?? Date.now();
      return {
        ...state,
        payments: [action.payload, ...state.payments].slice(0, MAX_RECENT_PAYMENTS),
        totalReceived: state.totalReceived + 1,
        tpsBuckets: addToTpsBuckets(state.tpsBuckets, nowMs),
        lastUpdate: new Date().toISOString(),
      };
    }
    case 'SET_METRICS':
      return { ...state, metrics: action.payload, lastUpdate: new Date().toISOString() };
    case 'SET_CONNECTION_STATUS':
      return { ...state, connectionStatus: action.payload, lastUpdate: new Date().toISOString() };
    case 'TOGGLE_PAUSE':
      return { ...state, isPaused: !state.isPaused, lastUpdate: new Date().toISOString() };
    case 'CLEAR':
      return { ...state, payments: [], totalReceived: 0, tpsBuckets: [], lastUpdate: new Date().toISOString() };
    default:
      return state;
  }
}

/** Current TPS: the most recent completed bucket's count, or 0 if no payments arrived in the last second. */
export function currentTps(buckets: TpsBucket[], nowMs: number = Date.now()): number {
  const secondEpoch = Math.floor(nowMs / 1000);
  const last = buckets[buckets.length - 1];
  if (!last || last.secondEpoch !== secondEpoch - 1) return 0;
  return last.count;
}

const SPARK_CHARS = ' ▁▂▃▄▅▆▇█';

/** Renders a bucket series as a single-line Unicode sparkline. */
export function renderSparkline(buckets: TpsBucket[]): string {
  if (buckets.length === 0) return SPARK_CHARS[0].repeat(TPS_WINDOW_SECONDS);
  const max = Math.max(...buckets.map((b) => b.count), 1);
  return buckets
    .map((b) => {
      const level = Math.round((b.count / max) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[level];
    })
    .join('');
}
