#!/usr/bin/env tsx
import React, { useEffect, useReducer } from 'react';
import { Text, Box, useInput, useApp } from 'ink';
import InkTable from 'ink-table';
import { PaymentDTO } from '../lib/types.js';
import {
  topTuiReducer,
  initialTopTuiState,
  currentTps,
  renderSparkline,
  type TopTuiAction,
  type TopTuiState,
  type TopTuiMetrics,
} from './top-tui-state.js';

export { topTuiReducer, initialTopTuiState };
export type { TopTuiAction, TopTuiState };

const Table = InkTable as unknown as React.FC<{
  data: Array<Record<string, string | number | boolean | null | undefined>>;
  padding?: number;
}>;

const BYTES_PER_MB = 1024 * 1024;

function formatHeap(bytes: number | null): string {
  if (bytes == null) return '—';
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function formatLatency(ms: number | null): string {
  if (ms == null) return '—';
  return `${ms.toFixed(1)} ms`;
}

export interface TopTuiProps {
  /** Opens the live feed. Called once on mount; its return value's close()
   * is called on unmount. Lets tests inject a fake socket instead of
   * dialing a real one. */
  connectFeed?: (handlers: {
    onPayment: (payment: PaymentDTO) => void;
    onStatusChange: (status: TopTuiState['connectionStatus']) => void;
  }) => { close: () => void };
  onMetricsPoll?: () => Promise<TopTuiMetrics>;
  metricsPollIntervalMs?: number;
  onQuit?: () => void;
}

const TopTui: React.FC<TopTuiProps> = ({ connectFeed, onMetricsPoll, metricsPollIntervalMs = 5000, onQuit }) => {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(topTuiReducer, undefined, initialTopTuiState);

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || input === 'q') {
      onQuit?.();
      exit();
    } else if (input === 'c') {
      dispatch({ type: 'CLEAR' });
    } else if (input === 'f') {
      dispatch({ type: 'TOGGLE_PAUSE' });
    }
  });

  useEffect(() => {
    if (!connectFeed) return;
    const connection = connectFeed({
      onPayment: (payment) => dispatch({ type: 'ADD_PAYMENT', payload: payment }),
      onStatusChange: (status) => dispatch({ type: 'SET_CONNECTION_STATUS', payload: status }),
    });
    return () => connection.close();
  }, [connectFeed]);

  useEffect(() => {
    if (!onMetricsPoll) return;
    const poller = onMetricsPoll;
    let cancelled = false;

    async function poll() {
      try {
        const metrics = await poller();
        if (!cancelled) dispatch({ type: 'SET_METRICS', payload: metrics });
      } catch {
        // A single failed metrics poll shouldn't disrupt the live feed;
        // the gauges just keep showing their last known value.
      }
    }

    poll();
    const interval = setInterval(poll, metricsPollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [onMetricsPoll, metricsPollIntervalMs]);

  const statusColor = {
    connected: 'green',
    disconnected: 'red',
    connecting: 'yellow',
  } as const;

  const tps = currentTps(state.tpsBuckets);
  const sparkline = renderSparkline(state.tpsBuckets);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="blue">
          🌊 Stellar Alerts — Live Ingestion Dashboard
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text color={statusColor[state.connectionStatus]}>● {state.connectionStatus.toUpperCase()}</Text>
        <Text dimColor> │ </Text>
        <Text color={state.isPaused ? 'yellow' : 'green'}>{state.isPaused ? '⏸ PAUSED' : '▶ LIVE'}</Text>
        <Text dimColor> │ </Text>
        <Text dimColor>Last Update: {new Date(state.lastUpdate).toLocaleTimeString()}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">
          Throughput
        </Text>
        <Box>
          <Text>TPS: </Text>
          <Text color="green" bold>
            {tps}
          </Text>
          <Text dimColor> │ </Text>
          <Text>Total Received: </Text>
          <Text color="blue">{state.totalReceived}</Text>
        </Box>
        <Text color="magenta">{sparkline}</Text>
        <Text dimColor>(last {state.tpsBuckets.length > 0 ? state.tpsBuckets.length : 0}s)</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">
          System
        </Text>
        <Box>
          <Text>Heap Used: </Text>
          <Text color="yellow">{formatHeap(state.metrics.heapUsedBytes)}</Text>
          <Text dimColor> │ </Text>
          <Text>Queue Latency: </Text>
          <Text color="yellow">{formatLatency(state.metrics.queueLatencyMs)}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">
          Live Payment Feed (Last 50)
        </Text>
        {state.payments.length > 0 ? (
          <Table
            data={state.payments.map((p) => ({
              Time: new Date(p.receivedAt).toLocaleTimeString(),
              Amount: `${p.amount} ${p.asset}`,
              From: `${p.fromAddress.slice(0, 8)}...${p.fromAddress.slice(-4)}`,
            }))}
            padding={1}
          />
        ) : (
          <Text dimColor>Waiting for payments...</Text>
        )}
      </Box>

      <Box>
        <Text dimColor>Shortcuts: [q] Quit | [c] Clear | [f] Pause/Resume feed | [Ctrl+C] Force Quit</Text>
      </Box>
    </Box>
  );
};

export default TopTui;
