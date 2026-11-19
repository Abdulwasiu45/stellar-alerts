import { describe, expect, it, vi } from 'vitest';
import { parseDashboardMetrics, fetchDashboardMetrics } from './metrics-client.js';

const SAMPLE_METRICS = `# HELP stellar_alerts_queue_waiting_jobs Number of waiting jobs in BullMQ queue
# TYPE stellar_alerts_queue_waiting_jobs gauge
stellar_alerts_queue_waiting_jobs{queue="webhooks"} 3

# HELP stellar_alerts_worker_processing_latency_ms Average job processing latency in milliseconds
# TYPE stellar_alerts_worker_processing_latency_ms gauge
stellar_alerts_worker_processing_latency_ms{queue="webhooks"} 42.5

# HELP process_uptime_seconds Process uptime in seconds
# TYPE process_uptime_seconds gauge
process_uptime_seconds 1234.5

# HELP nodejs_heap_used_bytes Process heap memory used in bytes
# TYPE nodejs_heap_used_bytes gauge
nodejs_heap_used_bytes 52428800
`;

describe('parseDashboardMetrics (#944)', () => {
  it('extracts heap used bytes and queue latency from a Prometheus exposition payload', () => {
    const result = parseDashboardMetrics(SAMPLE_METRICS);
    expect(result).toEqual({ heapUsedBytes: 52428800, queueLatencyMs: 42.5 });
  });

  it('returns null for a metric that is absent from the payload', () => {
    const result = parseDashboardMetrics('process_uptime_seconds 10\n');
    expect(result).toEqual({ heapUsedBytes: null, queueLatencyMs: null });
  });

  it('returns null for an empty payload', () => {
    expect(parseDashboardMetrics('')).toEqual({ heapUsedBytes: null, queueLatencyMs: null });
  });

  it('ignores a line with a non-numeric value instead of throwing', () => {
    const result = parseDashboardMetrics('nodejs_heap_used_bytes not-a-number\n');
    expect(result.heapUsedBytes).toBeNull();
  });
});

describe('fetchDashboardMetrics (#944)', () => {
  it('sends a Bearer token header when an API key is provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_METRICS,
    });

    await fetchDashboardMetrics('http://localhost:3001', 'secret-token', fetchImpl as any);

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:3001/metrics',
      { headers: { Authorization: 'Bearer secret-token' } },
    );
  });

  it('omits the Authorization header when no API key is provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => SAMPLE_METRICS });

    await fetchDashboardMetrics('http://localhost:3001', undefined, fetchImpl as any);

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3001/metrics', { headers: {} });
  });

  it('throws when the response is not ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

    await expect(fetchDashboardMetrics('http://localhost:3001', undefined, fetchImpl as any)).rejects.toThrow(
      /503/,
    );
  });
});
