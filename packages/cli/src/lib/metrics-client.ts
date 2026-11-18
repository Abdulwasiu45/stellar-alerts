/**
 * Minimal Prometheus text-format reader for the two gauges `top` needs
 * from GET /metrics (apps/api/src/plugins/metrics.ts):
 * nodejs_heap_used_bytes and stellar_alerts_worker_processing_latency_ms.
 * Deliberately does not parse the full exposition format (HELP/TYPE
 * comments, label sets beyond a bare match) since nothing else in the CLI
 * needs it.
 */
export interface DashboardMetrics {
  heapUsedBytes: number | null;
  queueLatencyMs: number | null;
}

function extractGaugeValue(text: string, metricName: string): number | null {
  const pattern = new RegExp(`^${metricName}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`, 'm');
  const match = text.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function parseDashboardMetrics(prometheusText: string): DashboardMetrics {
  return {
    heapUsedBytes: extractGaugeValue(prometheusText, 'nodejs_heap_used_bytes'),
    queueLatencyMs: extractGaugeValue(prometheusText, 'stellar_alerts_worker_processing_latency_ms'),
  };
}

export async function fetchDashboardMetrics(
  baseUrl: string,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DashboardMetrics> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetchImpl(`${baseUrl}/metrics`, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch metrics: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  return parseDashboardMetrics(text);
}
