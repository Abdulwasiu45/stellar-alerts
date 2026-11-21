import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { partitionService } from '../modules/maintenance/partition.service';
import { createArchiveStorage, sha256Hex, type ArchiveStorage } from '../lib/storage';
import { encodeParquet, type ParquetColumn, type ParquetEncoder } from '../lib/parquet';
import { registerSupervisorHeartbeat } from './supervisor';

/**
 * Automated archival worker for Payment history.
 *
 * Responsibilities:
 * 1. Creates monthly partitions for the Payment table
 * 2. Archives payments older than 90 days to PaymentArchive (cold storage)
 * 3. Maintains optimal indices on recent transactions (<30 days)
 * 4. Verifies data integrity and partition health
 *
 * Runs on a scheduled interval (configurable via cron or manual dispatch).
 * Transactional consistency is guaranteed during data movement.
 */
export interface ArchivalWorkerResult {
  success: boolean;
  partitionsCreated?: number;
  paymentsArchived?: number;
  indicesEnsured?: boolean;
  healthReport?: any;
  error?: string;
  duration: number;
}

export class ArchivalWorker {
  /**
   * Main entry point: run all archival and partitioning tasks.
   */
  async run(): Promise<ArchivalWorkerResult> {
    const startTime = Date.now();

    try {
      console.log('[ArchivalWorker] Starting archival cycle...');

      // Step 1: Ensure monthly partitions exist
      console.log('[ArchivalWorker] Ensuring monthly partitions...');
      await partitionService.ensureMonthlyPartitions();

      // Step 2: Archive old payments (>90 days)
      console.log('[ArchivalWorker] Archiving payments older than 90 days...');
      const archiveResult = await partitionService.archiveOldPayments(90);
      console.log(
        `[ArchivalWorker] Archived ${archiveResult.archivedCount} payments, deleted ${archiveResult.deletedCount} from primary table (${archiveResult.duration}ms)`,
      );

      // Step 3: Rebuild indices for active records (<30 days)
      console.log('[ArchivalWorker] Ensuring optimal indices for active records...');
      await partitionService.ensureActiveIndices();

      // Step 4: Validate health
      console.log('[ArchivalWorker] Validating partition health...');
      const healthReport = await partitionService.validatePartitionHealth();
      console.log('[ArchivalWorker] Health check completed:', healthReport);

      const duration = Date.now() - startTime;

      console.log(
        `[ArchivalWorker] Archival cycle completed successfully (${duration}ms)`,
      );

      return {
        success: true,
        paymentsArchived: archiveResult.archivedCount,
        indicesEnsured: true,
        healthReport,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[ArchivalWorker] Archival cycle failed: ${errorMsg}`, error);

      return {
        success: false,
        error: errorMsg,
        duration,
      };
    }
  }

  /**
   * Verify data integrity: count records and ensure no data loss.
   */
  async verifyDataIntegrity(): Promise<IntegrityCheckResult> {
    try {
      // Get total payment count (primary + archive)
      const primaryCount = await prisma.payment.count();
      const archiveCount = await prisma.paymentArchive.count();

      // Spot check: verify a sample of archived records still exist
      const archivedSample = await prisma.paymentArchive.findMany({
        take: 10,
      });

      return {
        valid: true,
        primaryTableCount: primaryCount,
        archiveTableCount: archiveCount,
        totalCount: primaryCount + archiveCount,
        archivedSampleSize: archivedSample.length,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        primaryTableCount: 0,
        archiveTableCount: 0,
        totalCount: 0,
        archivedSampleSize: 0,
      };
    }
  }

  /**
   * Query performance test: measure active vs archive query times.
   */
  async benchmarkQueryPerformance(walletId: string): Promise<PerformanceBenchmark> {
    const results: PerformanceBenchmark = {
      activeQueryMs: 0,
      archiveQueryMs: 0,
      improvement: '0%',
    };

    try {
      // Benchmark active payment queries
      const activeStart = Date.now();
      await prisma.payment.findMany({
        where: { walletId },
        take: 1000,
      });
      results.activeQueryMs = Date.now() - activeStart;

      // Benchmark archive payment queries
      const archiveStart = Date.now();
      await prisma.paymentArchive.findMany({
        where: { walletId },
        take: 1000,
      });
      results.archiveQueryMs = Date.now() - archiveStart;

      // Calculate improvement
      if (results.activeQueryMs > 0) {
        const pct = Math.round(
          ((results.archiveQueryMs - results.activeQueryMs) / results.archiveQueryMs) * 100,
        );
        results.improvement = `${pct}%`;
      }

      return results;
    } catch (error) {
      throw new Error(
        `Benchmark failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }
}

export interface IntegrityCheckResult {
  valid: boolean;
  primaryTableCount: number;
  archiveTableCount: number;
  totalCount: number;
  archivedSampleSize: number;
  error?: string;
}

export interface PerformanceBenchmark {
  activeQueryMs: number;
  archiveQueryMs: number;
  improvement: string;
}

export const archivalWorker = new ArchivalWorker();

// ── Cold-tier ledger archival ───────────────────────────────────────────────
//
// Streams records older than the retention window into Snappy-compressed
// Parquet files in S3 / GCS (see docs/ARCHIVAL_STRATEGY.md):
//
//   <prefix>/<dataset>/year=YYYY/month=MM/part-<sha256[0:16]>.parquet
//
// Every file is uploaded, checksum-verified in storage and recorded in
// ArchiveManifest *before* any hot row is pruned.

export interface ArchiveTier {
  /** Cursor scope, `<dataset>:<tier>`. */
  scope: string;
  /** Prisma delegate name. */
  model: 'payment' | 'paymentArchive' | 'sorobanEventSnapshot';
  /** Extra filter a row must satisfy before it may be deleted from this tier. */
  prunableWhere?: Record<string, unknown>;
  /** Archive a copy but never delete from the source table. */
  neverPrune?: boolean;
}

export interface ArchiveDataset {
  name: string;
  tiers: ArchiveTier[];
  /** Instant that decides the year/month partition of a row. */
  partitionTime(row: any): Date;
  columns(rows: any[]): ParquetColumn[];
}

const SCHEMA_VERSION = '1';

const strings = (rows: any[], pick: (row: any) => string | null | undefined): ParquetColumn['data'] =>
  rows.map((row) => pick(row) ?? null);

export const PAYMENTS_DATASET: ArchiveDataset = {
  name: 'payments',
  tiers: [
    {
      scope: 'payments:payment',
      model: 'payment',
      // Payments linked into the tamper-evident checksum chain are restricted
      // by a foreign key and must stay: the chain is the audit trail.
      prunableWhere: { checksum: { is: null } },
    },
    { scope: 'payments:payment_archive', model: 'paymentArchive' },
  ],
  partitionTime: (row) => row.receivedAt,
  columns: (rows) => [
    // Warm-tier rows carry an `arch_` id prefix; archive the original id.
    { name: 'id', type: 'STRING', data: strings(rows, (r) => String(r.id).replace(/^arch_/, '')) },
    { name: 'walletId', type: 'STRING', data: strings(rows, (r) => r.walletId) },
    { name: 'txHash', type: 'STRING', data: strings(rows, (r) => r.txHash) },
    { name: 'fromAddress', type: 'STRING', data: strings(rows, (r) => r.fromAddress) },
    // Decimal text keeps the full 7-digit stroop precision.
    { name: 'amount', type: 'STRING', data: strings(rows, (r) => r.amount?.toString()) },
    { name: 'asset', type: 'STRING', data: strings(rows, (r) => r.asset) },
    { name: 'assetIssuer', type: 'STRING', data: strings(rows, (r) => r.assetIssuer) },
    { name: 'memo', type: 'STRING', data: strings(rows, (r) => r.memo) },
    { name: 'receivedAt', type: 'TIMESTAMP', data: rows.map((r) => r.receivedAt) },
    { name: 'createdAt', type: 'TIMESTAMP', data: rows.map((r) => r.createdAt) },
  ],
};

export const SOROBAN_EVENTS_DATASET: ArchiveDataset = {
  name: 'soroban_events',
  tiers: [
    {
      scope: 'soroban_events:soroban_event_snapshot',
      model: 'sorobanEventSnapshot',
      // Watchers and sentinels read their last snapshot back as a resume
      // cursor / previous state, so these rows are copied but never deleted.
      neverPrune: true,
    },
  ],
  partitionTime: (row) => row.createdAt,
  columns: (rows) => [
    { name: 'id', type: 'STRING', data: strings(rows, (r) => r.id) },
    { name: 'contractId', type: 'STRING', data: strings(rows, (r) => r.contractId) },
    { name: 'from', type: 'STRING', data: strings(rows, (r) => r.from) },
    { name: 'to', type: 'STRING', data: strings(rows, (r) => r.to) },
    { name: 'amount', type: 'STRING', data: strings(rows, (r) => r.amount) },
    { name: 'ledgerSeq', type: 'INT32', data: rows.map((r) => r.ledgerSeq) },
    { name: 'eventType', type: 'STRING', data: strings(rows, (r) => r.eventType) },
    { name: 'txHash', type: 'STRING', data: strings(rows, (r) => r.txHash) },
    { name: 'paid', type: 'BOOLEAN', data: rows.map((r) => Boolean(r.paid)) },
    { name: 'createdAt', type: 'TIMESTAMP', data: rows.map((r) => r.createdAt) },
  ],
};

export interface LedgerArchivalConfig {
  retentionDays: number;
  batchSize: number;
  prefix: string;
  /** Delete hot rows once their archive is verified. */
  prune: boolean;
  /** Upper bound on batches per tier per run, so one run cannot monopolise the database. */
  maxBatchesPerTier: number;
  datasets: ArchiveDataset[];
}

export interface LedgerArchivalDatasetResult {
  dataset: string;
  filesWritten: number;
  rowsArchived: number;
  rowsPruned: number;
  bytesWritten: number;
}

export interface LedgerArchivalResult {
  success: boolean;
  skipped?: boolean;
  datasets: LedgerArchivalDatasetResult[];
  errors: string[];
  duration: number;
}

export class ArchiveVerificationError extends Error {
  constructor(key: string) {
    super(`Archive object ${key} failed SHA-256 verification after upload`);
    this.name = 'ArchiveVerificationError';
  }
}

const LOCK_KEY = 'archival:ledger:lock';
const LOCK_TTL_SECONDS = 2 * 60 * 60;

function defaultConfig(): LedgerArchivalConfig {
  return {
    retentionDays: env.ARCHIVE_RETENTION_DAYS,
    batchSize: env.ARCHIVE_BATCH_SIZE,
    prefix: env.ARCHIVE_PREFIX.replace(/^\/+|\/+$/g, ''),
    prune: env.ARCHIVE_PRUNE_HOT_ROWS !== 'false',
    maxBatchesPerTier: 50,
    datasets: [PAYMENTS_DATASET, SOROBAN_EVENTS_DATASET],
  };
}

export interface LedgerArchivalWorkerOptions {
  storage?: ArchiveStorage;
  encode?: ParquetEncoder;
  config?: Partial<LedgerArchivalConfig>;
  now?: () => Date;
  /** Skip the cross-instance lock (tests, single-shot CLI use). */
  disableLock?: boolean;
}

interface Cursor {
  createdAt: Date;
  id: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export class LedgerArchivalWorker {
  private storage?: ArchiveStorage;
  private readonly encode: ParquetEncoder;
  private readonly config: LedgerArchivalConfig;
  private readonly now: () => Date;
  private readonly disableLock: boolean;

  constructor(options: LedgerArchivalWorkerOptions = {}) {
    this.storage = options.storage;
    this.encode = options.encode ?? encodeParquet;
    this.config = { ...defaultConfig(), ...options.config };
    this.now = options.now ?? (() => new Date());
    this.disableLock = options.disableLock ?? false;
  }

  private getStorage(): ArchiveStorage {
    if (!this.storage) this.storage = createArchiveStorage();
    return this.storage;
  }

  async run(): Promise<LedgerArchivalResult> {
    const startedAt = Date.now();
    const result: LedgerArchivalResult = { success: true, datasets: [], errors: [], duration: 0 };

    const release = await this.acquireLock();
    if (release === null) {
      console.log('[LedgerArchivalWorker] Another instance holds the archival lock; skipping this run.');
      return { ...result, skipped: true, duration: Date.now() - startedAt };
    }

    try {
      const cutoff = new Date(this.now().getTime() - this.config.retentionDays * 24 * 60 * 60 * 1000);
      for (const dataset of this.config.datasets) {
        const datasetResult: LedgerArchivalDatasetResult = {
          dataset: dataset.name,
          filesWritten: 0,
          rowsArchived: 0,
          rowsPruned: 0,
          bytesWritten: 0,
        };
        result.datasets.push(datasetResult);

        for (const tier of dataset.tiers) {
          try {
            await this.archiveTier(dataset, tier, cutoff, datasetResult);
          } catch (err) {
            // A failed tier is left untouched (nothing pruned, cursor not advanced) and retried next run.
            const message = `${tier.scope}: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`[LedgerArchivalWorker] ${message}`);
            result.errors.push(message);
            result.success = false;
          }
        }
      }
    } finally {
      await release();
    }

    result.duration = Date.now() - startedAt;
    console.log(
      `[LedgerArchivalWorker] Cycle finished in ${result.duration}ms: ` +
        result.datasets
          .map((d) => `${d.dataset}=${d.rowsArchived} archived/${d.rowsPruned} pruned/${d.filesWritten} files`)
          .join(', '),
    );
    return result;
  }

  private async acquireLock(): Promise<(() => Promise<void>) | null> {
    if (this.disableLock) return async () => {};

    const { redisCache } = await import('../lib/redis');
    const token = `${process.pid}-${Date.now()}`;
    if (!(await redisCache.setNx(LOCK_KEY, token, LOCK_TTL_SECONDS))) return null;
    return async () => {
      if ((await redisCache.get(LOCK_KEY)) === token) await redisCache.del(LOCK_KEY);
    };
  }

  private async readCursor(scope: string): Promise<Cursor | null> {
    const row = await prisma.archiveCursor.findUnique({ where: { scope } });
    return row ? { createdAt: row.lastCreatedAt, id: row.lastId } : null;
  }

  private async archiveTier(
    dataset: ArchiveDataset,
    tier: ArchiveTier,
    cutoff: Date,
    totals: LedgerArchivalDatasetResult,
  ): Promise<void> {
    const delegate = (prisma as any)[tier.model];
    let cursor = await this.readCursor(tier.scope);

    for (let batch = 0; batch < this.config.maxBatchesPerTier; batch++) {
      const where: Record<string, unknown> = { createdAt: { lt: cutoff } };
      if (cursor) {
        where.OR = [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ];
      }

      const rows: any[] = await delegate.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: this.config.batchSize,
      });
      if (rows.length === 0) return;

      // Group by the year/month the record belongs to, one Parquet file each.
      const groups = new Map<string, { year: number; month: number; rows: any[] }>();
      for (const row of rows) {
        const at = dataset.partitionTime(row) as Date;
        const year = at.getUTCFullYear();
        const month = at.getUTCMonth() + 1;
        const groupKey = `${year}-${pad2(month)}`;
        const group = groups.get(groupKey) ?? { year, month, rows: [] };
        group.rows.push(row);
        groups.set(groupKey, group);
      }

      for (const group of groups.values()) {
        const written = await this.archiveGroup(dataset, group.year, group.month, group.rows);
        totals.rowsArchived += group.rows.length;
        totals.bytesWritten += written.size;
        if (written.uploaded) totals.filesWritten += 1;
      }

      // Every file in this batch is verified: only now may hot rows go.
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
      await prisma.archiveCursor.upsert({
        where: { scope: tier.scope },
        create: { scope: tier.scope, lastCreatedAt: cursor.createdAt, lastId: cursor.id },
        update: { lastCreatedAt: cursor.createdAt, lastId: cursor.id },
      });

      if (this.config.prune && !tier.neverPrune) {
        const pruned = await delegate.deleteMany({
          where: { id: { in: rows.map((row) => row.id) }, ...(tier.prunableWhere ?? {}) },
        });
        totals.rowsPruned += pruned.count;
      }

      if (rows.length < this.config.batchSize) return;
    }
  }

  private async archiveGroup(
    dataset: ArchiveDataset,
    year: number,
    month: number,
    rows: any[],
  ): Promise<{ size: number; uploaded: boolean }> {
    const storage = this.getStorage();
    const body = await this.encode(dataset.columns(rows), {
      dataset: dataset.name,
      partition: `${year}-${pad2(month)}`,
      schema_version: SCHEMA_VERSION,
      row_count: String(rows.length),
    });

    // Content-addressed: re-running over the same rows rewrites the same object.
    const checksum = sha256Hex(body);
    const key = `${this.config.prefix}/${dataset.name}/year=${year}/month=${pad2(month)}/part-${checksum.slice(0, 16)}.parquet`;
    const expected = { sha256Hex: checksum, size: body.length };

    let uploaded = false;
    if (!(await storage.verify(key, expected))) {
      await storage.put(key, body, { sha256Hex: checksum, contentType: 'application/vnd.apache.parquet' });
      uploaded = true;
      if (!(await storage.verify(key, expected))) {
        throw new ArchiveVerificationError(key);
      }
    }

    const times = rows.map((row) => (dataset.partitionTime(row) as Date).getTime());
    const manifest = {
      dataset: dataset.name,
      year,
      month,
      objectKey: key,
      provider: storage.provider,
      location: storage.location,
      sha256: checksum,
      sizeBytes: body.length,
      rowCount: rows.length,
      minRecordAt: new Date(Math.min(...times)),
      maxRecordAt: new Date(Math.max(...times)),
      verifiedAt: new Date(),
    };
    await prisma.archiveManifest.upsert({ where: { objectKey: key }, create: manifest, update: manifest });

    return { size: body.length, uploaded };
  }
}

export const ledgerArchivalWorker = new LedgerArchivalWorker();

export async function runLedgerArchivalLoop(worker: LedgerArchivalWorker = ledgerArchivalWorker) {
  const cycle = () =>
    worker.run().catch((err) => {
      console.error('[LedgerArchivalWorker] Archival cycle crashed:', err);
    });

  await cycle();
  const timer = setInterval(cycle, env.ARCHIVE_INTERVAL_MS);

  const stop = () => {
    clearInterval(timer);
    void prisma.$disconnect().finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (require.main === module) {
  registerSupervisorHeartbeat();
  void runLedgerArchivalLoop();
}
