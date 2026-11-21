import { Job, Queue, Worker, type ConnectionOptions } from 'bullmq';
import { getRedisClient } from '../redis';
import { createLogger } from '../logger';
import { FairShareQueueScheduler, SUBSCRIBER_TIERS } from './fair-scheduler';

const log = createLogger({ module: 'FairDispatcher' });

/**
 * Fair dispatch job data
 */
export interface FairDispatchJobData {
  tenantId: string;
  tierName?: string;
  payload: Record<string, any>;
  [key: string]: any;
}

/**
 * Fair dispatch result
 */
export interface FairDispatchResult {
  tenantId: string;
  processed: boolean;
  waitTimeMs: number;
  reason?: string;
}

/**
 * Wraps BullMQ worker with fair scheduling to prevent noisy tenants
 * from monopolizing dispatcher capacity.
 */
export class FairDispatcher<T extends FairDispatchJobData = FairDispatchJobData> {
  private scheduler: FairShareQueueScheduler;
  private redis = getRedisClient();
  private worker: Worker<T> | null = null;
  private processingQueueLengths = new Map<string, number>();
  private stats = {
    jobsScheduled: 0,
    jobsDeferred: 0,
    jobsProcessed: 0,
    jobsFailed: 0,
  };

  constructor(private jobProcessor: (job: T) => Promise<any>) {
    this.scheduler = new FairShareQueueScheduler();
  }

  /**
   * Starts the fair dispatcher worker
   */
  async start(
    queueName: string,
    options: {
      connection: ConnectionOptions;
      concurrency?: number;
      baseDelay?: number;
    } = {} as any,
  ): Promise<Worker<T>> {
    const { connection, concurrency = 10, baseDelay = 100 } = options;

    this.worker = new Worker<T>(
      queueName,
      async (job) => {
        return this.processJobWithFairScheduling(job, baseDelay);
      },
      {
        connection,
        concurrency,
      },
    );

    this.worker.on('completed', (job) => {
      this.stats.jobsProcessed++;
      const tenantId = (job.data as any).tenantId;
      if (tenantId) {
        this.scheduler.recordJobCompletion(tenantId, 0);
      }
    });

    this.worker.on('failed', (job, error) => {
      this.stats.jobsFailed++;
      log.error(
        {
          jobId: job?.id,
          tenantId: (job?.data as any)?.tenantId,
          error: error.message,
        },
        'Fair dispatch job failed',
      );
    });

    log.info({ queueName, concurrency }, 'Started fair dispatcher worker');
    return this.worker;
  }

  /**
   * Processes a job with fair scheduling checks
   */
  private async processJobWithFairScheduling(
    job: Job<T>,
    baseDelay: number,
  ): Promise<FairDispatchResult> {
    const { tenantId, tierName = 'professional', ...jobData } = job.data;

    if (!tenantId) {
      log.warn({ jobId: job.id }, 'Job missing tenantId, processing immediately');
      return {
        tenantId: 'unknown',
        processed: true,
        waitTimeMs: 0,
      };
    }

    // Get current queue length for this tenant
    const queueLength = this.processingQueueLengths.get(tenantId) || 0;

    // Check if tenant can process
    const decision = await this.scheduler.canScheduleJob(tenantId, tierName, queueLength);

    if (!decision.canProcess) {
      // Rate limited: defer job by returning a delay
      this.stats.jobsDeferred++;

      // Exponential backoff based on wait time
      const delayMs = Math.min(decision.waitTimeMs, 5000) + baseDelay;

      log.debug(
        {
          jobId: job.id,
          tenantId,
          tierName,
          waitTimeMs: decision.waitTimeMs,
          delayMs,
          queueLength: decision.queueLength,
        },
        '⏳ Deferring job due to rate limit',
      );

      // Re-queue with delay
      await job.moveToDelayed(Date.now() + delayMs, job.token);

      return {
        tenantId,
        processed: false,
        waitTimeMs: delayMs,
        reason: 'rate_limited',
      };
    }

    this.stats.jobsScheduled++;

    // Update queue length
    this.processingQueueLengths.set(tenantId, queueLength + 1);

    try {
      // Process the job
      const result = await this.jobProcessor(job.data);

      // Update queue length after completion
      this.processingQueueLengths.set(tenantId, Math.max(0, queueLength - 1));

      return {
        tenantId,
        processed: true,
        waitTimeMs: 0,
      };
    } catch (error) {
      this.processingQueueLengths.set(tenantId, Math.max(0, queueLength - 1));
      throw error;
    }
  }

  /**
   * Enqueues a job with fair scheduling metadata
   */
  async enqueueJob(
    queue: Queue<T>,
    jobName: string,
    data: T,
    options?: {
      tenantId: string;
      tierName?: string;
      [key: string]: any;
    },
  ): Promise<Job<T>> {
    const { tenantId, tierName, ...jobOptions } = options || {};

    if (!tenantId) {
      throw new Error('tenantId is required for fair scheduling');
    }

    // Ensure data has tenant metadata
    const jobData: T = {
      ...data,
      tenantId,
      tierName: tierName || 'professional',
    } as T;

    return (queue as any).add(jobName, jobData, jobOptions);
  }

  /**
   * Gets fair scheduling statistics
   */
  getStats() {
    const schedulerStats = this.scheduler.getStats();

    return {
      ...schedulerStats,
      dispatcherStats: {
        jobsScheduled: this.stats.jobsScheduled,
        jobsDeferred: this.stats.jobsDeferred,
        jobsProcessed: this.stats.jobsProcessed,
        jobsFailed: this.stats.jobsFailed,
      },
      processingQueueLengths: Object.fromEntries(this.processingQueueLengths),
    };
  }

  /**
   * Stops the worker
   */
  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }

  /**
   * Gets the scheduler instance (for advanced usage)
   */
  getScheduler(): FairShareQueueScheduler {
    return this.scheduler;
  }
}

/**
 * Creates a fair dispatcher instance
 */
export function createFairDispatcher<T extends FairDispatchJobData = FairDispatchJobData>(
  processor: (job: T) => Promise<any>,
): FairDispatcher<T> {
  return new FairDispatcher(processor);
}
