# Ledger Archival Strategy (cold tier)

Years of raw payment records in PostgreSQL are expensive and slow down the
operational indexes. The `LedgerArchivalWorker`
([`apps/api/src/workers/archival.worker.ts`](../apps/api/src/workers/archival.worker.ts))
streams records older than the retention window (default **90 days**) into
compressed Parquet files in object storage, verifies them, and then prunes the
hot rows it is allowed to prune.

```
Payment / PaymentArchive ──┐
SorobanEventSnapshot ──────┼─► Parquet (Snappy) ─► S3 / GCS ─► SHA-256 verify ─► ArchiveManifest ─► prune hot rows
```

## What is archived

| Dataset          | Source tables                          | Partitioned by | Pruned afterwards                       |
| ---------------- | -------------------------------------- | -------------- | --------------------------------------- |
| `payments`       | `Payment`, `PaymentArchive` (warm)     | `receivedAt`   | Yes, except payments in the checksum chain |
| `soroban_events` | `SorobanEventSnapshot`                 | `createdAt`    | **No** (copied only)                    |

Why some rows stay:

- **Checksum chain.** `PaymentChecksum` references `Payment` with
  `ON DELETE RESTRICT`; the chain is the tamper-evident audit trail and is never
  rewritten. Payments with a chain entry are archived but remain in the hot
  table.
- **Soroban snapshots.** Watchers and sentinels read their last snapshot back as
  a resume cursor / previous state, so deleting old rows could replay events or
  reset a sentinel. They are copied only.

## Object layout

Hive-style partitions, so Athena, BigQuery external tables, DuckDB and Spark
prune by `year` / `month` without any catalog work:

```
<ARCHIVE_PREFIX>/payments/year=2026/month=07/part-3f9a1c2b7d4e8a10.parquet
<ARCHIVE_PREFIX>/soroban_events/year=2026/month=07/part-91bc03a2e5d7f4c8.parquet
```

- `part-<…>` is the first 16 hex characters of the file's SHA-256. Re-running
  over the same rows rewrites the same object, and late-arriving rows for an
  old month land in a new `part-` file instead of overwriting history.
- Files are Snappy-compressed Parquet. Amounts are stored as decimal **strings**
  to keep full stroop precision (cast on read); timestamps are
  `TIMESTAMP_MILLIS`. File metadata carries `dataset`, `partition`,
  `schema_version` and `row_count`.

## Integrity guarantees

For every file, in order:

1. Encode to Parquet and compute its SHA-256.
2. Upload with the checksum attached (`x-amz-checksum-sha256` on S3, plus a
   `sha256` metadata entry).
3. **Verify** the stored object: size must match and the checksum must match.
   S3 reports the checksum it computed itself. Stores without server-side
   checksums (GCS interop, MinIO, R2) are read back and hashed.
4. Record the object in `ArchiveManifest` (key, SHA-256, size, row count, time
   range, provider, bucket, verification time).
5. Only after **every** file of the batch verified: advance the
   `ArchiveCursor` and delete the prunable hot rows.

A failed upload or verification throws before step 5. Nothing is pruned, the
cursor does not move, and the next run retries the identical batch. Objects are
content-addressed, so a retry is idempotent.

The `ArchiveCursor` (high-water mark on `(createdAt, id)`) guarantees each row
is exported exactly once, even rows that cannot be pruned. Only one worker runs
at a time (Redis lock, 2h TTL).

## Configuration

| Variable                    | Default                    | Purpose |
| --------------------------- | -------------------------- | ------- |
| `ARCHIVE_STORAGE_PROVIDER`  | `local`                    | `local`, `s3` or `gcs` |
| `ARCHIVE_BUCKET`            |                            | Bucket (required for `s3` / `gcs`) |
| `ARCHIVE_PREFIX`            | `ledger-archive`           | Key prefix |
| `ARCHIVE_REGION`            | `us-east-1`                | S3 region |
| `ARCHIVE_ENDPOINT`          |                            | Custom endpoint (MinIO, R2). `gcs` defaults to `https://storage.googleapis.com` |
| `ARCHIVE_ACCESS_KEY_ID`     |                            | Static key. For `gcs` this is an HMAC interoperability key. Empty on `s3` = default AWS credential chain |
| `ARCHIVE_SECRET_ACCESS_KEY` |                            | Matching secret |
| `ARCHIVE_LOCAL_DIR`         | `<tmpdir>/stellar-alerts-archive` | Directory for the `local` provider |
| `ARCHIVE_RETENTION_DAYS`    | `90`                       | Rows older than this are archived |
| `ARCHIVE_BATCH_SIZE`        | `10000`                    | Rows read per batch |
| `ARCHIVE_PRUNE_HOT_ROWS`    | `true`                     | Set `false` for a copy-only dry run |
| `ARCHIVE_INTERVAL_MS`       | `21600000` (6h)            | Loop interval of the standalone worker |

Run it with `npm run dev:archival -w apps/api` (or
`node dist/workers/archival.worker.js` in production). GCS is reached through
its S3-compatible XML API, so create an HMAC key for a service account with
`storage.objects.create` / `get` on the bucket.

Recommended bucket settings: versioning on, a lifecycle rule moving
`ledger-archive/` to an infrequent-access / archive class after 30 days, and
object lock if the archive is used for compliance retention.

## Querying the archive

```sql
-- DuckDB
SELECT asset, sum(CAST(amount AS DECIMAL(38,7))) AS volume
FROM read_parquet('s3://my-bucket/ledger-archive/payments/year=2026/month=*/*.parquet',
                  hive_partitioning = true)
GROUP BY asset;
```

## Auditing and recovery

- `ArchiveManifest` lists every verified object. Compare `sha256` / `sizeBytes`
  with the stored object to audit the bucket at any time.
- A pruned payment can be restored by reading its month's files (filter on
  `id` or `txHash`) and re-inserting the row.
- Do not run the warm-tier move (`partitionService.archiveOldPayments`) together
  with `ARCHIVE_PRUNE_HOT_ROWS=false`: rows copied to the cold tier and later
  moved into `PaymentArchive` would be exported a second time.
