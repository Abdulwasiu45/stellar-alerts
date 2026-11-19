# Daily Financial Ledger Reconciliation

A scheduled job that proves the DB's recorded `Payment` rows match the
Stellar ledger's own record of each wallet's payment operations, one UTC
day at a time, built from one service
(`apps/api/src/modules/analytics/reconciliation.service.ts`) and one
worker (`apps/api/src/workers/reconciliation.worker.ts`).

## What it checks

For every non-deleted `Wallet`, for a given UTC day window
`[windowStart, windowEnd)`:

1. Fetches that wallet's `Payment` rows with `receivedAt` in the window
   from the DB.
2. Fetches that wallet's `payment`-type operations in the same window
   directly from Horizon (bypassing the DB and the live ingestion
   pipeline entirely, via `stellar.getPaymentsSinceResult`).
3. Compares the two sets by transaction hash, flagging:
   - `missing_from_ledger` — a DB row with no matching Horizon operation.
   - `missing_from_db` — a Horizon operation with no matching DB row
     (what a missed ingestion looks like).
   - `amount_mismatch` — present in both, but the recorded amount differs.

Zero discrepancies across every wallet is the "zero ledger drift" proof
the job exists to produce. Any discrepancy is logged at `error` level and
triggers an email to every address in `ADMIN_EMAILS` (comma-separated),
summarizing the wallet, the discrepancy count, and each individual
mismatch.

## Schedule

`scheduleReconciliationJob()` runs `runReconciliationJob()` daily at
00:00 UTC, reconciling the day that just ended (same "run a day behind"
reasoning as `PAYMENT_CHECKSUM_CHAIN.md`'s daily root job: a payment
ingested in the last seconds of a UTC day may not have committed to the
DB yet at the instant that day turns over).

## A known limitation: no point-in-time cursor

Horizon's `payments().forAccount()` API pages forward from a cursor, but
there is no API to jump directly to "the cursor as of a given timestamp."
`IngestionCursor` only retains the *current* live cursor, not a history of
where it was at some point in the past, so this job cannot seek directly
to the start of the target day for a wallet with a long payment history.

Instead, `reconcileWallet` pages forward from the very beginning of the
account's payment history every run, discarding records before the
window and stopping once a page's records cross the window's end. For a
wallet that has accumulated a very large payment history, this re-scans
all of it every night.

`MAX_PAGES_PER_WALLET` (500 pages of 200 records = 100,000 operations)
bounds the worst case. If a wallet's scan hits that cap before reaching
the target window, the result is marked `scanTruncated: true` and logged
as a warning rather than silently returned as a false "clean" result —
but a genuinely truncated scan means that wallet's reconciliation for that
day is **incomplete**, not failed. Operators should treat a
`scanTruncated` wallet as "needs a dedicated backfill-aware reconciliation
pass," which is out of scope for this job.

## Testing

`modules/analytics/__tests__/reconciliation.service.test.ts` covers the
comparison logic directly: clean match, each of the three discrepancy
kinds, window exclusion, an all-nodes-Horizon-outage failure (which raises
rather than reporting a false-clean result), and the truncation flag.

`workers/__tests__/reconciliation.worker.test.ts` covers the
alerting behavior: no email on a clean report, one email per configured
admin address on a discrepancy, and that one admin's email failing to
send doesn't prevent the others from being attempted.
