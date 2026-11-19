import {
  Queue,
  Worker,
  type ConnectionOptions,
  type DefaultJobOptions,
  type JobsOptions,
} from 'bullmq';

export type QueueLane = 'critical' | 'high' | 'standard' | 'bulk';

export interface QueueLaneConfig {
  concurrency: number;
  priority: number;
}

export const QUEUE_LANE_CONFIGS: Record<QueueLane, QueueLaneConfig> = {
  critical: { concurrency: 10, priority: 1 },
  high: { concurrency: 6, priority: 2 },
  standard: { concurrency: 4, priority: 3 },
  bulk: { concurrency: 2, priority: 4 },
};

const laneEnqueuedCounts: Record<QueueLane, number> = {
  critical: 0,
  high: 0,
  standard: 0,
  bulk: 0,
};

export interface QueueLaneManagerOptions<T = Record<string, unknown>> {
  baseQueueName?: string;
  connection?: ConnectionOptions;
  defaultJobOptions?: DefaultJobOptions;
  processor?: (job: { data: T }) => Promise<unknown>;
  concurrency?: number;
}

/**
 * Classifies an alert payload into its delivery priority lane.
 * Critical/high severity alerts bypass bulk backlogs to prevent head-of-line blocking.
 */
export function resolveLaneForAlert(data: { severity?: string }): QueueLane {
  const normalized = data.severity?.toLowerCase().trim();
  if (normalized === 'critical') return 'critical';
  if (normalized === 'high') return 'high';
  if (normalized === 'bulk' || normalized === 'low') return 'bulk';
  return 'standard';
}

/**
 * Manages lane-partitioned BullMQ queues and optional workers for priority alert dispatch (#724).
 */
export class QueueLaneManager<T = Record<string, unknown>> {
  private readonly baseQueueName: string;
  private readonly connection?: ConnectionOptions;
  private readonly defaultJobOptions?: DefaultJobOptions;
  private readonly queues = new Map<QueueLane, Queue<T>>();
  private readonly workers = new Map<QueueLane, Worker<T>>();

  constructor(options: QueueLaneManagerOptions<T> = {}) {
    this.baseQueueName = options.baseQueueName ?? 'payment-alerts';
    this.connection = options.connection;
    this.defaultJobOptions = options.defaultJobOptions;

    if (options.connection && options.processor) {
      for (const lane of Object.keys(QUEUE_LANE_CONFIGS) as QueueLane[]) {
        const queueName = this.getQueueName(lane);
        const laneConcurrency = Math.max(
          1,
          options.concurrency ?? QUEUE_LANE_CONFIGS[lane].concurrency,
        );
        const worker = new Worker<T>(
          queueName,
          async (job) => options.processor!({ data: job.data }),
          { connection: options.connection, concurrency: laneConcurrency },
        );
        this.workers.set(lane, worker);
      }
    }
  }

  public getQueueName(lane: QueueLane, baseQueueName = this.baseQueueName): string {
    return `${baseQueueName}-${lane}`;
  }

  private getOrCreateQueue(lane: QueueLane): Queue<T> {
    const existing = this.queues.get(lane);
    if (existing) return existing;
    if (!this.connection) {
      throw new Error('QueueLaneManager cannot enqueue without a Redis connection');
    }
    const queue = new Queue<T>(this.getQueueName(lane), {
      connection: this.connection,
      defaultJobOptions: this.defaultJobOptions,
    });
    this.queues.set(lane, queue);
    return queue;
  }

  public async enqueue(lane: QueueLane, name: string, data: T, opts?: JobsOptions) {
    const queue = this.getOrCreateQueue(lane);
    laneEnqueuedCounts[lane] += 1;
    return queue.add(name as never, data as never, {
      priority: QUEUE_LANE_CONFIGS[lane].priority,
      ...opts,
    });
  }

  public async close(): Promise<void> {
    await Promise.all([
      ...Array.from(this.workers.values()).map((worker) => worker.close()),
      ...Array.from(this.queues.values()).map((queue) => queue.close()),
    ]);
    this.workers.clear();
    this.queues.clear();
  }
}

/**
 * Renders Prometheus exposition lines tracking alert volume per priority lane.
 */
export function renderQueueLaneMetrics(): string {
  const lines = [
    '# HELP stellar_alerts_queue_lane_enqueued_total Total jobs enqueued per priority lane',
    '# TYPE stellar_alerts_queue_lane_enqueued_total counter',
  ];
  for (const lane of Object.keys(QUEUE_LANE_CONFIGS) as QueueLane[]) {
    lines.push(`stellar_alerts_queue_lane_enqueued_total{lane="${lane}"} ${laneEnqueuedCounts[lane]}`);
  }
  return lines.join('\n');
}
