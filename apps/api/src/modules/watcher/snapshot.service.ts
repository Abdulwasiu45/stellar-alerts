import { createHash } from 'crypto';
import { getRedisClient } from '../../lib/redis';
import { prisma } from '../../lib/prisma';
import { createLogger } from '../../lib/logger';

const log = createLogger({ module: 'StateSnapshotManager' });

/**
 * Represents the state of a single worker that needs to be checkpointed
 */
export interface WorkerStateSnapshot {
  walletId: string;
  pagingToken: string;
  lastProcessedLedger: number;
  inFlightTransactionIds: string[];
  timestamp: number;
}

/**
 * Represents the complete snapshot including all worker states
 */
export interface StateCheckpoint {
  workerStates: WorkerStateSnapshot[];
  ledgerSequence: number;
  timestamp: number;
  checksum: string;
}

/**
 * Configuration for snapshot manager
 */
export interface SnapshotManagerConfig {
  snapshotIntervalLedgers?: number;
  snapshotRedisKeyPrefix?: string;
  maxSnapshotsRetained?: number;
  compressionEnabled?: boolean;
}

const DEFAULT_CONFIG: Required<SnapshotManagerConfig> = {
  snapshotIntervalLedgers: 10,
  snapshotRedisKeyPrefix: 'watcher:snapshot:',
  maxSnapshotsRetained: 5,
  compressionEnabled: true,
};

/**
 * StateSnapshotManager handles periodic checkpointing of watcher worker state
 * to enable sub-second failover recovery. Snapshots are stored in Redis with
 * CRC32 integrity verification.
 */
export class StateSnapshotManager {
  private config: Required<SnapshotManagerConfig>;
  private lastSnapshotLedger: number = 0;
  private redis = getRedisClient();

  constructor(config: SnapshotManagerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculates CRC32 checksum of data for integrity verification
   */
  private calculateCRC32(data: string): string {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc ^= data.charCodeAt(i);
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    return ((crc ^ 0xffffffff) >>> 0).toString(16);
  }

  /**
   * Converts snapshot to compact binary representation
   */
  private serializeSnapshot(snapshot: StateCheckpoint): string {
    return JSON.stringify(snapshot);
  }

  /**
   * Deserializes snapshot from binary representation
   */
  private deserializeSnapshot(data: string): StateCheckpoint {
    return JSON.parse(data);
  }

  /**
   * Determines if a new snapshot should be created based on ledger progress
   */
  private shouldCreateSnapshot(currentLedger: number): boolean {
    const ledgerDelta = currentLedger - this.lastSnapshotLedger;
    return ledgerDelta >= this.config.snapshotIntervalLedgers;
  }

  /**
   * Fetches all active wallet ingestion cursors from database
   */
  private async fetchActiveWorkerStates(): Promise<WorkerStateSnapshot[]> {
    const cursors = await prisma.ingestionCursor.findMany({
      select: {
        walletId: true,
        pagingToken: true,
      },
    });

    return cursors.map((cursor) => ({
      walletId: cursor.walletId,
      pagingToken: cursor.pagingToken,
      lastProcessedLedger: this.extractLedgerFromPagingToken(cursor.pagingToken),
      inFlightTransactionIds: [],
      timestamp: Date.now(),
    }));
  }

  /**
   * Extracts ledger sequence from Horizon paging token (last 64-bit value)
   */
  private extractLedgerFromPagingToken(pagingToken: string): number {
    try {
      // Paging tokens are formatted as "ledger-ledger-sequence-operation-order"
      const parts = pagingToken.split('-');
      if (parts.length >= 3) {
        const ledger = parseInt(parts[0], 10);
        return isNaN(ledger) ? 0 : ledger;
      }
    } catch (error) {
      log.warn({ pagingToken }, 'Failed to extract ledger from paging token');
    }
    return 0;
  }

  /**
   * Creates a state snapshot at the current ledger
   * Saves to Redis with automatic TTL expiration
   */
  async createSnapshot(ledgerSequence: number): Promise<StateCheckpoint> {
    if (!this.shouldCreateSnapshot(ledgerSequence)) {
      return null as any;
    }

    try {
      const workerStates = await this.fetchActiveWorkerStates();

      const snapshot: StateCheckpoint = {
        workerStates,
        ledgerSequence,
        timestamp: Date.now(),
        checksum: '', // Calculated after serialization
      };

      // Serialize and calculate checksum
      const serialized = this.serializeSnapshot(snapshot);
      snapshot.checksum = this.calculateCRC32(serialized);

      // Store in Redis with 24-hour TTL
      const redisKey = `${this.config.snapshotRedisKeyPrefix}${ledgerSequence}`;
      const ttlSeconds = 24 * 60 * 60; // 24 hours

      await this.redis.setex(redisKey, ttlSeconds, serialized);

      // Maintain a list of recent snapshots for quick recovery
      await this.redis.lpush(`${this.config.snapshotRedisKeyPrefix}history`, ledgerSequence);
      await this.redis.ltrim(`${this.config.snapshotRedisKeyPrefix}history`, 0, this.config.maxSnapshotsRetained - 1);

      this.lastSnapshotLedger = ledgerSequence;

      log.info(
        {
          ledger: ledgerSequence,
          workerCount: workerStates.length,
          checksum: snapshot.checksum,
          timestamp: snapshot.timestamp,
        },
        '📸 State snapshot created successfully',
      );

      return snapshot;
    } catch (error) {
      log.error({ ledger: ledgerSequence, error }, '❌ Failed to create state snapshot');
      throw error;
    }
  }

  /**
   * Retrieves the most recent snapshot from Redis
   */
  async getLatestSnapshot(): Promise<StateCheckpoint | null> {
    try {
      // Get the most recent ledger from history
      const ledgers = await this.redis.lrange(`${this.config.snapshotRedisKeyPrefix}history`, 0, 0);

      if (!ledgers || ledgers.length === 0) {
        return null;
      }

      const latestLedger = parseInt(ledgers[0], 10);
      return this.getSnapshot(latestLedger);
    } catch (error) {
      log.error({ error }, 'Failed to retrieve latest snapshot');
      return null;
    }
  }

  /**
   * Retrieves a specific snapshot by ledger sequence
   */
  async getSnapshot(ledgerSequence: number): Promise<StateCheckpoint | null> {
    try {
      const redisKey = `${this.config.snapshotRedisKeyPrefix}${ledgerSequence}`;
      const data = await this.redis.get(redisKey);

      if (!data) {
        return null;
      }

      const snapshot = this.deserializeSnapshot(data);
      return snapshot;
    } catch (error) {
      log.error({ ledger: ledgerSequence, error }, 'Failed to retrieve snapshot');
      return null;
    }
  }

  /**
   * Verifies snapshot integrity using CRC32 checksum
   */
  async verifySnapshotIntegrity(snapshot: StateCheckpoint): Promise<boolean> {
    try {
      const snapshotCopy = { ...snapshot };
      const originalChecksum = snapshotCopy.checksum;
      snapshotCopy.checksum = '';

      const serialized = this.serializeSnapshot(snapshotCopy);
      const calculatedChecksum = this.calculateCRC32(serialized);

      const isValid = originalChecksum === calculatedChecksum;

      if (!isValid) {
        log.warn(
          { originalChecksum, calculatedChecksum, ledger: snapshot.ledgerSequence },
          '⚠️ Snapshot integrity check failed',
        );
      }

      return isValid;
    } catch (error) {
      log.error({ error }, 'Error verifying snapshot integrity');
      return false;
    }
  }

  /**
   * Recovers worker state from latest snapshot
   * Returns cursor state that can be used to resume ingestion
   */
  async recoverFromSnapshot(): Promise<Map<string, string> | null> {
    try {
      const snapshot = await this.getLatestSnapshot();

      if (!snapshot) {
        log.info('No snapshot available for recovery');
        return null;
      }

      // Verify integrity before applying
      const isValid = await this.verifySnapshotIntegrity(snapshot);
      if (!isValid) {
        log.error({ ledger: snapshot.ledgerSequence }, 'Snapshot integrity check failed, cannot recover');
        return null;
      }

      // Build cursor map for resume
      const cursorMap = new Map<string, string>();
      for (const workerState of snapshot.workerStates) {
        cursorMap.set(workerState.walletId, workerState.pagingToken);
      }

      log.info(
        {
          ledger: snapshot.ledgerSequence,
          walletCount: cursorMap.size,
          timestamp: snapshot.timestamp,
        },
        '✅ Recovered worker state from snapshot',
      );

      return cursorMap;
    } catch (error) {
      log.error({ error }, 'Failed to recover from snapshot');
      return null;
    }
  }

  /**
   * Cleans up old snapshots beyond retention policy
   */
  async cleanupOldSnapshots(): Promise<number> {
    try {
      let deletedCount = 0;

      // Get all snapshots from history beyond retention
      const allSnapshots = await this.redis.lrange(`${this.config.snapshotRedisKeyPrefix}history`, 0, -1);

      if (allSnapshots.length > this.config.maxSnapshotsRetained) {
        const toDelete = allSnapshots.slice(this.config.maxSnapshotsRetained);

        for (const ledger of toDelete) {
          const redisKey = `${this.config.snapshotRedisKeyPrefix}${ledger}`;
          await this.redis.del(redisKey);
          deletedCount++;
        }

        // Trim history list
        await this.redis.ltrim(
          `${this.config.snapshotRedisKeyPrefix}history`,
          0,
          this.config.maxSnapshotsRetained - 1,
        );
      }

      if (deletedCount > 0) {
        log.info({ deletedCount }, 'Cleaned up old snapshots');
      }

      return deletedCount;
    } catch (error) {
      log.error({ error }, 'Failed to cleanup old snapshots');
      return 0;
    }
  }

  /**
   * Gets snapshot statistics for monitoring
   */
  async getSnapshotStats(): Promise<{
    latestLedger: number | null;
    snapshotCount: number;
    oldestSnapshot: number | null;
    newestSnapshot: number | null;
  }> {
    try {
      const snapshots = await this.redis.lrange(`${this.config.snapshotRedisKeyPrefix}history`, 0, -1);
      const ledgers = snapshots.map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));

      return {
        latestLedger: ledgers.length > 0 ? ledgers[0] : null,
        snapshotCount: ledgers.length,
        newestSnapshot: ledgers.length > 0 ? Math.max(...ledgers) : null,
        oldestSnapshot: ledgers.length > 0 ? Math.min(...ledgers) : null,
      };
    } catch (error) {
      log.error({ error }, 'Failed to get snapshot stats');
      return {
        latestLedger: null,
        snapshotCount: 0,
        oldestSnapshot: null,
        newestSnapshot: null,
      };
    }
  }
}

// Export singleton instance
export const stateSnapshotManager = new StateSnapshotManager();
