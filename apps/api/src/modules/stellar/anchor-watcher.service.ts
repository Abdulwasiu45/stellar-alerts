import { prisma } from '../../lib/prisma';
import {
  fetchAnchorTransactionStatus,
  isTerminalAnchorStatus,
  type AnchorProtocol,
  type AnchorTransactionStatus,
} from '../../lib/anchor';
import { validateUrlForSsrf } from '../../utils/ssrf';
import { createLogger } from '../../lib/logger';
import { ConflictError } from '../../lib/errors';
import { deliverUserAlert, escapeTelegramHtml } from './alert-delivery';

const log = createLogger({ module: 'AnchorLifecycleWatcher' });

// ── Unified lifecycle state ─────────────────────────────────────────────────

/**
 * Protocol-independent view of where a fiat on/off-ramp transfer is. SEP-24
 * and SEP-31 use different (overlapping) status vocabularies; subscribers
 * operating payment rails want one answer to "what is this waiting on?".
 */
export type UnifiedAnchorState =
  | 'AWAITING_USER'
  | 'ACTION_REQUIRED'
  | 'AWAITING_ANCHOR'
  | 'COMPLETED'
  | 'REFUNDED'
  | 'EXPIRED'
  | 'FAILED';

const STATUS_TO_UNIFIED: Record<string, UnifiedAnchorState> = {
  // The user (or sending client) has to do something.
  incomplete: 'AWAITING_USER',
  pending_user_transfer_start: 'AWAITING_USER',
  pending_user: 'AWAITING_USER',
  pending_sender: 'AWAITING_USER',
  // Blocked until someone fixes something (trustline, KYC data, hold).
  pending_trust: 'ACTION_REQUIRED',
  pending_customer_info_update: 'ACTION_REQUIRED',
  pending_transaction_info_update: 'ACTION_REQUIRED',
  on_hold: 'ACTION_REQUIRED',
  // The anchor (or the rail behind it) is working.
  pending_user_transfer_complete: 'AWAITING_ANCHOR',
  pending_anchor: 'AWAITING_ANCHOR',
  pending_external: 'AWAITING_ANCHOR',
  pending_stellar: 'AWAITING_ANCHOR',
  pending_receiver: 'AWAITING_ANCHOR',
  // Terminal.
  completed: 'COMPLETED',
  refunded: 'REFUNDED',
  expired: 'EXPIRED',
  error: 'FAILED',
  no_market: 'FAILED',
  too_small: 'FAILED',
  too_large: 'FAILED',
};

/** Unknown / future anchor statuses are treated as the anchor still working. */
export function unifiedAnchorState(status: string): UnifiedAnchorState {
  return STATUS_TO_UNIFIED[status] ?? 'AWAITING_ANCHOR';
}

/** Happy-path order of statuses; an earlier position means "less far along". */
const HAPPY_PATH: Record<AnchorProtocol, string[]> = {
  sep24: [
    'incomplete',
    'pending_user_transfer_start',
    'pending_user_transfer_complete',
    'pending_external',
    'pending_anchor',
    'pending_stellar',
    'completed',
  ],
  sep31: ['pending_sender', 'pending_stellar', 'pending_receiver', 'pending_external', 'completed'],
};

/**
 * True when a reported transition goes backwards: leaving a terminal state,
 * or moving to an earlier step of the happy path (e.g. completed ->
 * pending_anchor). Skipping steps forward is normal — polling can miss short
 * intermediate states — so it is not flagged.
 */
export function isRegression(protocol: AnchorProtocol, from: string | null, to: string): boolean {
  if (!from || from === to) return false;
  if (isTerminalAnchorStatus(protocol, from)) return true;

  const order = HAPPY_PATH[protocol];
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  return fromIndex !== -1 && toIndex !== -1 && toIndex < fromIndex;
}

// ── Memo matching ───────────────────────────────────────────────────────────

/** Memo ids are uint64 and may arrive zero-padded; text and hash memos compare verbatim. */
export function normalizeMemo(memo: string, memoType?: string | null): string {
  const trimmed = memo.trim();
  if (memoType === 'id' && /^\d+$/.test(trimmed)) return trimmed.replace(/^0+(?=\d)/, '');
  return trimmed;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface AnchorWatchRecord {
  id: string;
  userId: string;
  anchorEndpoint: string;
  anchorTxId: string;
  protocol: string;
  lastKnownStatus: string | null;
  kind?: string | null;
  anchorAccount?: string | null;
  memo?: string | null;
  memoType?: string | null;
  stellarTxHash?: string | null;
}

export interface AnchorLifecycleNotification {
  event: 'anchor.transfer.status_changed' | 'anchor.transfer.stellar_matched';
  watchId: string;
  userId: string;
  protocol: AnchorProtocol;
  anchorEndpoint: string;
  anchorTxId: string;
  kind: string | null;
  previousStatus: string | null;
  status: string | null;
  state: UnifiedAnchorState | null;
  stellarTxHash: string | null;
  anomaly: boolean;
  amountIn?: string | null;
  amountOut?: string | null;
  moreInfoUrl?: string | null;
  occurredAt: string;
}

export type AnchorLifecycleNotifier = (notification: AnchorLifecycleNotification) => Promise<void> | void;

export interface OnChainPayment {
  txHash: string;
  from: string;
  to: string;
  memo?: string | null;
  memoType?: string | null;
  /** Owner of the wallet the payment was ingested for. */
  userId?: string;
}

export interface RegisterAnchorTransferInput {
  anchorEndpoint: string;
  anchorTxId: string;
  protocol: AnchorProtocol;
  kind?: string;
  anchorAccount?: string;
  memo?: string;
  memoType?: 'text' | 'id' | 'hash';
}

// ── Notification wording & delivery ─────────────────────────────────────────

const STATE_LABEL: Record<UnifiedAnchorState, string> = {
  AWAITING_USER: 'waiting for you',
  ACTION_REQUIRED: 'needs action',
  AWAITING_ANCHOR: 'being processed by the anchor',
  COMPLETED: 'completed',
  REFUNDED: 'refunded',
  EXPIRED: 'expired',
  FAILED: 'failed',
};

export function buildAnchorTelegramMessage(n: AnchorLifecycleNotification): string {
  const lines =
    n.event === 'anchor.transfer.stellar_matched'
      ? [
          '🔗 <b>Anchor transfer matched on-chain</b>',
          `<b>Anchor tx:</b> <code>${escapeTelegramHtml(n.anchorTxId)}</code>`,
          `<b>Stellar tx:</b> <code>${escapeTelegramHtml(n.stellarTxHash ?? '')}</code>`,
        ]
      : [
          `${n.anomaly ? '⚠️' : '🏦'} <b>Anchor transfer ${n.state ? STATE_LABEL[n.state] : 'updated'}</b>`,
          `<b>Anchor tx:</b> <code>${escapeTelegramHtml(n.anchorTxId)}</code>`,
          `<b>Status:</b> ${escapeTelegramHtml(n.previousStatus ?? '(new)')} → ${escapeTelegramHtml(n.status ?? '')}`,
          n.anomaly ? 'The anchor reported a status that moves backwards.' : '',
          n.moreInfoUrl ? `<b>More info:</b> ${escapeTelegramHtml(n.moreInfoUrl)}` : '',
        ];
  return lines.filter(Boolean).join('\n');
}

export const deliverAnchorNotification: AnchorLifecycleNotifier = async (notification) => {
  await deliverUserAlert(notification.userId, { ...notification }, buildAnchorTelegramMessage(notification));
};

// ── Watcher ─────────────────────────────────────────────────────────────────

export interface AnchorLifecycleWatcherDeps {
  fetchStatus?: typeof fetchAnchorTransactionStatus;
  notify?: AnchorLifecycleNotifier;
  /** Validates a user-supplied anchor URL against the SSRF policy. */
  validateEndpoint?: (url: string) => Promise<unknown>;
  authToken?: () => string | undefined;
}

/**
 * Unified SEP-24 / SEP-31 anchor lifecycle tracking:
 *
 *  - polls the anchor's transfer server for status transitions and keeps an
 *    append-only history (pending_user_transfer_start -> pending_anchor ->
 *    completed, ...),
 *  - correlates the on-chain Stellar payment with the registered anchor
 *    transfer by memo + the anchor's account, so the off-chain status and
 *    the ledger transaction show up as one record.
 */
export class AnchorLifecycleWatcher {
  private readonly fetchStatus: typeof fetchAnchorTransactionStatus;
  private readonly notify: AnchorLifecycleNotifier;
  private readonly validateEndpoint: (url: string) => Promise<unknown>;
  private readonly authToken: () => string | undefined;

  constructor(deps: AnchorLifecycleWatcherDeps = {}) {
    this.fetchStatus = deps.fetchStatus ?? fetchAnchorTransactionStatus;
    this.notify = deps.notify ?? deliverAnchorNotification;
    this.validateEndpoint = deps.validateEndpoint ?? ((url) => validateUrlForSsrf(url));
    this.authToken = deps.authToken ?? (() => process.env.ANCHOR_SEP31_AUTH_TOKEN);
  }

  /** Registers an anchor transfer for tracking. Idempotent for the owning user. */
  async register(userId: string, input: RegisterAnchorTransferInput) {
    // The anchor URL is fetched server-side on every poll.
    await this.validateEndpoint(input.anchorEndpoint);

    const existing = await prisma.anchorTransactionWatch.findUnique({
      where: {
        anchorEndpoint_anchorTxId: { anchorEndpoint: input.anchorEndpoint, anchorTxId: input.anchorTxId },
      },
    });
    if (existing) {
      if (existing.userId !== userId) {
        throw new ConflictError('This anchor transaction is already being tracked');
      }
      return existing;
    }

    return prisma.anchorTransactionWatch.create({
      data: {
        userId,
        anchorEndpoint: input.anchorEndpoint,
        anchorTxId: input.anchorTxId,
        protocol: input.protocol,
        kind: input.kind,
        anchorAccount: input.anchorAccount,
        memo: input.memo ? normalizeMemo(input.memo, input.memoType) : undefined,
        memoType: input.memoType,
      },
    });
  }

  /**
   * Checks one transfer against its anchor. A changed status is persisted
   * together with a history event, then notified. Returns the fetched status,
   * or null when the anchor could not be reached (the watch is left as-is).
   */
  async pollWatch(watch: AnchorWatchRecord): Promise<AnchorTransactionStatus | null> {
    const protocol = watch.protocol as AnchorProtocol;

    try {
      await this.validateEndpoint(watch.anchorEndpoint);
    } catch (err: unknown) {
      log.warn(`Skipping ${watch.anchorTxId}: endpoint rejected (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }

    const status = await this.fetchStatus(protocol, watch.anchorEndpoint, watch.anchorTxId, this.authToken());
    if (!status) return null;

    // Details the anchor reports fill in what the user did not supply at registration.
    const learned: Record<string, string> = {};
    if (!watch.kind && status.kind) learned.kind = status.kind;
    if (!watch.anchorAccount && status.anchorAccount) learned.anchorAccount = status.anchorAccount;
    if (!watch.memo && status.memo) {
      learned.memo = normalizeMemo(status.memo, status.memoType);
      if (status.memoType) learned.memoType = status.memoType;
    }
    if (!watch.stellarTxHash && status.stellarTransactionId) learned.stellarTxHash = status.stellarTransactionId;

    if (status.status === watch.lastKnownStatus) {
      if (Object.keys(learned).length > 0) {
        await prisma.anchorTransactionWatch.update({ where: { id: watch.id }, data: learned });
      }
      return status;
    }

    const state = unifiedAnchorState(status.status);
    const anomaly = isRegression(protocol, watch.lastKnownStatus, status.status);
    const stellarTxHash = learned.stellarTxHash ?? watch.stellarTxHash ?? null;

    await prisma.$transaction([
      prisma.anchorTransactionWatch.update({
        where: { id: watch.id },
        data: {
          ...learned,
          lastKnownStatus: status.status,
          unifiedState: state,
          statusChangedAt: new Date(),
        },
      }),
      prisma.anchorTransactionEvent.create({
        data: {
          watchId: watch.id,
          type: 'STATUS_CHANGED',
          fromStatus: watch.lastKnownStatus,
          toStatus: status.status,
          unifiedState: state,
          stellarTxHash,
          anomaly,
          detail: status.statusMessage ?? undefined,
        },
      }),
    ]);

    await this.safeNotify({
      event: 'anchor.transfer.status_changed',
      watchId: watch.id,
      userId: watch.userId,
      protocol,
      anchorEndpoint: watch.anchorEndpoint,
      anchorTxId: watch.anchorTxId,
      kind: watch.kind ?? status.kind ?? null,
      previousStatus: watch.lastKnownStatus,
      status: status.status,
      state,
      stellarTxHash,
      anomaly,
      amountIn: status.amountIn,
      amountOut: status.amountOut,
      moreInfoUrl: status.moreInfoUrl,
      occurredAt: new Date().toISOString(),
    });

    return status;
  }

  /** One poll pass over every transfer that has not reached a terminal state. */
  async pollAll(): Promise<number> {
    const watches = await prisma.anchorTransactionWatch.findMany();
    let polled = 0;

    for (const watch of watches) {
      if (watch.lastKnownStatus && isTerminalAnchorStatus(watch.protocol as AnchorProtocol, watch.lastKnownStatus)) {
        continue;
      }
      try {
        await this.pollWatch(watch);
        polled += 1;
      } catch (err: unknown) {
        log.error(`Failed to process watch ${watch.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return polled;
  }

  /**
   * Links an ingested on-chain payment to the anchor transfer it belongs to.
   *
   * A memo alone is not an identity (text memos collide across anchors), so a
   * transfer matches only when the payment moves funds to/from the anchor's
   * account for that transfer, carries its memo, and was ingested for the
   * same user that registered the transfer. Returns the matched watch id.
   */
  async correlatePayment(payment: OnChainPayment): Promise<string | null> {
    if (!payment.memo || !payment.userId) return null;

    const candidates = await prisma.anchorTransactionWatch.findMany({
      where: {
        userId: payment.userId,
        stellarTxHash: null,
        anchorAccount: { in: [payment.from, payment.to] },
        memo: { not: null },
      },
    });

    const match = candidates.find(
      (watch) =>
        watch.memo !== null &&
        normalizeMemo(watch.memo, watch.memoType) === normalizeMemo(payment.memo!, payment.memoType ?? watch.memoType),
    );
    if (!match) return null;

    // Guards against two ingestion paths (stream + poll) matching the same payment.
    const claimed = await prisma.anchorTransactionWatch.updateMany({
      where: { id: match.id, stellarTxHash: null },
      data: { stellarTxHash: payment.txHash },
    });
    if (claimed.count === 0) return null;

    await prisma.anchorTransactionEvent.create({
      data: {
        watchId: match.id,
        type: 'STELLAR_TX_MATCHED',
        stellarTxHash: payment.txHash,
        toStatus: match.lastKnownStatus,
        unifiedState: match.lastKnownStatus ? unifiedAnchorState(match.lastKnownStatus) : undefined,
        detail: `Matched by memo on anchor account ${match.anchorAccount}`,
      },
    });

    await this.safeNotify({
      event: 'anchor.transfer.stellar_matched',
      watchId: match.id,
      userId: match.userId,
      protocol: match.protocol as AnchorProtocol,
      anchorEndpoint: match.anchorEndpoint,
      anchorTxId: match.anchorTxId,
      kind: match.kind,
      previousStatus: match.lastKnownStatus,
      status: match.lastKnownStatus,
      state: match.lastKnownStatus ? unifiedAnchorState(match.lastKnownStatus) : null,
      stellarTxHash: payment.txHash,
      anomaly: false,
      occurredAt: new Date().toISOString(),
    });

    return match.id;
  }

  private async safeNotify(notification: AnchorLifecycleNotification): Promise<void> {
    try {
      await this.notify(notification);
    } catch (err: unknown) {
      log.warn(`Notification failed for watch ${notification.watchId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const anchorLifecycleWatcher = new AnchorLifecycleWatcher();
