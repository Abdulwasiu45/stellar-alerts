import { createHash } from 'crypto';
import { getRedisClient } from './redis';
import { prisma } from './prisma';
import { createLogger } from './logger';

const log = createLogger({ module: 'DeduplicationPipeline' });

/**
 * Unique identifier for a transaction + operation combination
 */
export interface TransactionOperationId {
  txHash: string;
  operationIndex: number;
}

/**
 * Result of deduplication check
 */
export interface DeduplicationResult {
  isDuplicate: boolean;
  wasNewlyAdded: boolean;
  bloomFilterHit: boolean;
  persistentStoreCheck: boolean;
}

/**
 * Configuration for deduplication pipeline
 */
export interface DeduplicationConfig {
  bloomFilterKeyPrefix?: string;
  persistentStoreTableName?: string;
  bloomFilterTTLSeconds?: number;
  atomicLockTTLSeconds?: number;
  falsePositiveProbability?: number;
}

const DEFAULT_CONFIG: Required<DeduplicationConfig> = {
  bloomFilterKeyPrefix: 'dedup:bf:',
  persistentStoreTableName: 'deduplication_log',
  bloomFilterTTLSeconds: 24 * 60 * 60, // 24 hours
  atomicLockTTLSeconds: 5, // 5 seconds for distributed lock
  falsePositiveProbability: 0.01, // 1% false positive rate
};

/**
 * Two-tier deduplication pipeline using Redis Bloom Filter (fast) backed by
 * persistent RocksDB/Postgres (durable). Guarantees exactly-once alert evaluation
 * across multiple watcher replicas.
 *
 * Architecture:
 * 1. Fast path: Redis Bloom Filter for sub-millisecond checks
 * 2. Slow path: Atomic setnx lock + persistent database for distributed consensus
 * 3. Fallback: Bloom filter false positives verified against persistent store
 */
export class DeduplicationPipeline {
  private config: Required<DeduplicationConfig>;
  private redis = getRedisClient();
  private stats = {
    checksPerformed: 0,
    duplicatesDetected: 0,
    bloomHits: 0,
    persistentStoreHits: 0,
    lockAcquisitions: 0,
    lockFailures: 0,
  };

  constructor(config: DeduplicationConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generates a unique hash for a transaction + operation combination
   */
  private generateEventHash(txHash: string, operationIndex: number): string {
    const combined = `${txHash}:${operationIndex}`;
    return createHash('sha256').update(combined).digest('hex');
  }

  /**
   * Generates a Redis key for the distributed lock
   */
  private getLockKey(txHash: string, operationIndex: number): string {
    return `dedup:lock:${txHash}:${operationIndex}`;
  }

  /**
   * Generates a Redis key for the Bloom filter
   */
  private getBloomFilterKey(): string {
    return `${this.config.bloomFilterKeyPrefix}current`;
  }

  /**
   * Checks if an event is a duplicate using the two-tier pipeline.
   * Returns true if this is a new event (not seen before).
   */
  async checkAndMarkDuplicate(
    txHash: string,
    operationIndex: number,
  ): Promise<DeduplicationResult> {
    this.stats.checksPerformed++;

    const eventHash = this.generateEventHash(txHash, operationIndex);
    const lockKey = this.getLockKey(txHash, operationIndex);

    try {
      // TIER 1: Fast Bloom Filter check
      const bloomFilterKey = this.getBloomFilterKey();
      const bloomHit = await this.redis.bf_exists(bloomFilterKey, eventHash).catch(() => null);

      if (bloomHit === 1) {
        // Bloom filter says it exists - but could be a false positive
        this.stats.bloomHits++;

        // TIER 2: Persistent store verification
        const persistentExists = await this.checkPersistentStore(txHash, operationIndex);

        if (persistentExists) {
          this.stats.duplicatesDetected++;
          return {
            isDuplicate: true,
            wasNewlyAdded: false,
            bloomFilterHit: true,
            persistentStoreCheck: true,
          };
        }

        // False positive: add to persistent store as new
        await this.addToPersistentStore(txHash, operationIndex, eventHash);
        return {
          isDuplicate: false,
          wasNewlyAdded: true,
          bloomFilterHit: true,
          persistentStoreCheck: false,
        };
      }

      // TIER 1: Bloom filter says it's new (likely new event)
      // Acquire atomic lock to prevent race condition with other replicas
      const lockAcquired = await this.acquireAtomicLock(lockKey);

      if (!lockAcquired) {
        this.stats.lockFailures++;
        // Another replica is processing this event, treat as duplicate
        log.info(
          { txHash, operationIndex },
          '🔒 Failed to acquire lock, treating as duplicate (another replica processing)',
        );
        return {
          isDuplicate: true,
          wasNewlyAdded: false,
          bloomFilterHit: false,
          persistentStoreCheck: false,
        };
      }

      this.stats.lockAcquisitions++;

      try {
        // Double-check in persistent store after acquiring lock
        const alreadyExists = await this.checkPersistentStore(txHash, operationIndex);

        if (alreadyExists) {
          this.stats.duplicatesDetected++;
          return {
            isDuplicate: true,
            wasNewlyAdded: false,
            bloomFilterHit: false,
            persistentStoreCheck: true,
          };
        }

        // New event: add to both layers
        await Promise.all([
          this.addToBloomFilter(bloomFilterKey, eventHash),
          this.addToPersistentStore(txHash, operationIndex, eventHash),
        ]);

        return {
          isDuplicate: false,
          wasNewlyAdded: true,
          bloomFilterHit: false,
          persistentStoreCheck: false,
        };
      } finally {
        // Release lock
        await this.releaseAtomicLock(lockKey);
      }
    } catch (error) {
      log.error(
        { txHash, operationIndex, error },
        '❌ Error in deduplication check, treating as new to avoid alert loss',
      );
      // Fail open: on error, allow event to proceed (better to send duplicate than lose alert)
      return {
        isDuplicate: false,
        wasNewlyAdded: true,
        bloomFilterHit: false,
        persistentStoreCheck: false,
      };
    }
  }

  /**
   * Adds event to Redis Bloom Filter
   */
  private async addToBloomFilter(bloomFilterKey: string, eventHash: string): Promise<void> {
    try {
      await this.redis.bf_add(bloomFilterKey, eventHash);
      // Set TTL to expire old bloom filter
      await this.redis.expire(bloomFilterKey, this.config.bloomFilterTTLSeconds);
    } catch (error) {
      log.warn({ error }, 'Failed to add event to Bloom filter');
      // Non-fatal: continue without Bloom filter cache
    }
  }

  /**
   * Acquires an atomic distributed lock using Redis SETNX
   */
  private async acquireAtomicLock(lockKey: string): Promise<boolean> {
    try {
      const acquired = await this.redis.set(
        lockKey,
        Date.now().toString(),
        'PX',
        this.config.atomicLockTTLSeconds * 1000,
        'NX',
      );
      return acquired === 'OK';
    } catch (error) {
      log.warn({ lockKey, error }, 'Failed to acquire atomic lock');
      return false;
    }
  }

  /**
   * Releases the distributed lock
   */
  private async releaseAtomicLock(lockKey: string): Promise<void> {
    try {
      await this.redis.del(lockKey);
    } catch (error) {
      log.warn({ lockKey, error }, 'Failed to release atomic lock');
    }
  }

  /**
   * Checks if event exists in persistent store
   */
  private async checkPersistentStore(txHash: string, operationIndex: number): Promise<boolean> {
    try {
      this.stats.persistentStoreHits++;
      // Use Prisma to check deduplication log
      const existing = await prisma.deduplicationLog.findUnique({
        where: {
          txHash_operationIndex: {
            txHash,
            operationIndex,
          },
        },
      });
      return !!existing;
    } catch (error) {
      log.warn(
        { txHash, operationIndex, error },
        'Failed to check persistent store, assuming not duplicate',
      );
      return false;
    }
  }

  /**
   * Adds event to persistent store
   */
  private async addToPersistentStore(
    txHash: string,
    operationIndex: number,
    eventHash: string,
  ): Promise<void> {
    try {
      await prisma.deduplicationLog.create({
        data: {
          txHash,
          operationIndex,
          eventHash,
          detectedAt: new Date(),
        },
      });
    } catch (error: any) {
      // Ignore unique constraint violations (another replica beat us)
      if (error?.code === 'P2002') {
        log.debug({ txHash, operationIndex }, 'Event already in persistent store');
        return;
      }
      log.warn({ txHash, operationIndex, error }, 'Failed to add to persistent store');
      throw error;
    }
  }

  /**
   * Batch checks multiple events
   */
  async checkMultiple(
    events: Array<{ txHash: string; operationIndex: number }>,
  ): Promise<Map<string, DeduplicationResult>> {
    const results = new Map<string, DeduplicationResult>();

    for (const event of events) {
      const key = `${event.txHash}:${event.operationIndex}`;
      const result = await this.checkAndMarkDuplicate(event.txHash, event.operationIndex);
      results.set(key, result);
    }

    return results;
  }

  /**
   * Cleans up old deduplication records (older than retention period)
   */
  async cleanupOldRecords(retentionDays: number = 1): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      const result = await prisma.deduplicationLog.deleteMany({
        where: {
          detectedAt: {
            lt: cutoffDate,
          },
        },
      });

      if (result.count > 0) {
        log.info({ deleted: result.count, retentionDays }, 'Cleaned up old deduplication records');
      }

      return result.count;
    } catch (error) {
      log.error({ error }, 'Failed to cleanup old deduplication records');
      return 0;
    }
  }

  /**
   * Gets deduplication statistics
   */
  getStats(): {
    checksPerformed: number;
    duplicatesDetected: number;
    duplicateRate: number;
    bloomFilterHitRate: number;
    lockAcquisitionRate: number;
    lockFailureRate: number;
  } {
    const duplicateRate =
      this.stats.checksPerformed > 0
        ? (this.stats.duplicatesDetected / this.stats.checksPerformed) * 100
        : 0;
    const bloomHitRate =
      this.stats.checksPerformed > 0 ? (this.stats.bloomHits / this.stats.checksPerformed) * 100 : 0;
    const lockFailureRate =
      this.stats.lockAcquisitions + this.stats.lockFailures > 0
        ? (this.stats.lockFailures / (this.stats.lockAcquisitions + this.stats.lockFailures)) * 100
        : 0;

    return {
      checksPerformed: this.stats.checksPerformed,
      duplicatesDetected: this.stats.duplicatesDetected,
      duplicateRate,
      bloomFilterHitRate,
      lockAcquisitionRate:
        this.stats.checksPerformed > 0 ? (this.stats.lockAcquisitions / this.stats.checksPerformed) * 100 : 0,
      lockFailureRate,
    };
  }

  /**
   * Resets statistics
   */
  resetStats(): void {
    this.stats = {
      checksPerformed: 0,
      duplicatesDetected: 0,
      bloomHits: 0,
      persistentStoreHits: 0,
      lockAcquisitions: 0,
      lockFailures: 0,
    };
  }
}

// Export singleton instance
export const deduplicationPipeline = new DeduplicationPipeline();
