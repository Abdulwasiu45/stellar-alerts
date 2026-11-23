const ANCHOR_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The subset of SEP-24 (`GET /transaction`) and SEP-31 (`GET /transactions/:id`)
 * transaction status fields the watcher cares about. Both protocols expose a
 * `status` string on their transaction resource, just nested slightly
 * differently and with a different vocabulary of status values.
 */
export interface AnchorTransactionStatus {
  id: string;
  status: string;
  /** Raw status message from the anchor, if provided. */
  statusMessage?: string | null;
  amountIn?: string | null;
  amountOut?: string | null;
  /** SEP-24 only: URL the user should visit to complete an interactive step. */
  moreInfoUrl?: string | null;
  /** "deposit" | "withdrawal" (SEP-24) or "payment" (SEP-31). */
  kind?: string | null;
  /** The anchor's Stellar account for the on-chain leg of this transfer. */
  anchorAccount?: string | null;
  /** Memo that ties the on-chain payment to this anchor transaction. */
  memo?: string | null;
  memoType?: string | null;
  /** Hash of the Stellar transaction the anchor reports for this transfer. */
  stellarTransactionId?: string | null;
}

/** SEP-24 transaction states that represent the fiat flow moving forward. */
export const SEP24_TERMINAL_STATUSES = new Set([
  'completed',
  'refunded',
  'expired',
  'error',
]);

/** SEP-31 transaction states considered terminal (flow finished either way). */
export const SEP31_TERMINAL_STATUSES = new Set([
  'completed',
  'refunded',
  'expired',
  'error',
]);

export type AnchorProtocol = 'sep24' | 'sep31';

function normalizeEndpoint(anchorEndpoint: string): string {
  return anchorEndpoint.replace(/\/+$/, '');
}

/**
 * Fetches the current status of a single SEP-24 transaction from an anchor's
 * transfer server (`GET {endpoint}/transaction?id=...`).
 *
 * Returns null (rather than throwing) on any network error, non-2xx
 * response, or malformed body so a watcher polling many anchors can skip a
 * single flaky one without losing the rest of the pass.
 */
export async function fetchSep24TransactionStatus(
  anchorEndpoint: string,
  anchorTxId: string,
  authToken?: string,
): Promise<AnchorTransactionStatus | null> {
  try {
    const url = `${normalizeEndpoint(anchorEndpoint)}/transaction?id=${encodeURIComponent(anchorTxId)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
      signal: AbortSignal.timeout(ANCHOR_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`[Anchor] SEP-24 status fetch for ${anchorTxId} failed with HTTP ${response.status}`);
      return null;
    }

    const body: any = await response.json();
    const tx = body?.transaction;
    if (!tx || typeof tx.status !== 'string') return null;

    return {
      id: tx.id,
      status: tx.status,
      statusMessage: tx.message ?? null,
      amountIn: tx.amount_in ?? null,
      amountOut: tx.amount_out ?? null,
      moreInfoUrl: tx.more_info_url ?? null,
      kind: tx.kind ?? null,
      // Withdrawals: the user pays the anchor's account with the given memo.
      // Deposits: the anchor pays the user, echoing the user-supplied memo.
      anchorAccount: tx.withdraw_anchor_account ?? null,
      memo: tx.withdraw_memo ?? tx.deposit_memo ?? null,
      memoType: tx.withdraw_memo_type ?? tx.deposit_memo_type ?? null,
      stellarTransactionId: tx.stellar_transaction_id ?? null,
    };
  } catch (error: any) {
    console.error(`[Anchor] Error fetching SEP-24 transaction ${anchorTxId}:`, error?.message || error);
    return null;
  }
}

/**
 * Fetches the current status of a single SEP-31 transaction
 * (`GET {endpoint}/transactions/:id`). SEP-31 is a direct/cross-border
 * payment rail (sending anchor -> receiving anchor), so it requires the
 * caller's SEP-10 auth token — there's no anonymous polling like SEP-24.
 */
export async function fetchSep31TransactionStatus(
  anchorEndpoint: string,
  anchorTxId: string,
  authToken: string,
): Promise<AnchorTransactionStatus | null> {
  try {
    const url = `${normalizeEndpoint(anchorEndpoint)}/transactions/${encodeURIComponent(anchorTxId)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(ANCHOR_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(`[Anchor] SEP-31 status fetch for ${anchorTxId} failed with HTTP ${response.status}`);
      return null;
    }

    const body: any = await response.json();
    const tx = body?.transaction;
    if (!tx || typeof tx.status !== 'string') return null;

    return {
      id: tx.id,
      status: tx.status,
      statusMessage: tx.status_message ?? null,
      amountIn: tx.amount_in ?? null,
      amountOut: tx.amount_out ?? null,
      moreInfoUrl: null,
      kind: 'payment',
      anchorAccount: tx.stellar_account_id ?? null,
      memo: tx.stellar_memo ?? null,
      memoType: tx.stellar_memo_type ?? null,
      stellarTransactionId: tx.stellar_transaction_id ?? null,
    };
  } catch (error: any) {
    console.error(`[Anchor] Error fetching SEP-31 transaction ${anchorTxId}:`, error?.message || error);
    return null;
  }
}

/** Dispatches to the right SEP-24/SEP-31 fetcher based on the watch's protocol. */
export async function fetchAnchorTransactionStatus(
  protocol: AnchorProtocol,
  anchorEndpoint: string,
  anchorTxId: string,
  authToken?: string,
): Promise<AnchorTransactionStatus | null> {
  if (protocol === 'sep31') {
    if (!authToken) {
      console.warn(`[Anchor] Skipping SEP-31 transaction ${anchorTxId}: no auth token configured`);
      return null;
    }
    return fetchSep31TransactionStatus(anchorEndpoint, anchorTxId, authToken);
  }
  return fetchSep24TransactionStatus(anchorEndpoint, anchorTxId, authToken);
}

/** True once a transaction has reached a terminal state for its protocol. */
export function isTerminalAnchorStatus(protocol: AnchorProtocol, status: string): boolean {
  return protocol === 'sep31' ? SEP31_TERMINAL_STATUSES.has(status) : SEP24_TERMINAL_STATUSES.has(status);
}
