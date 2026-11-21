import { prisma } from '../../lib/prisma';
import { stellar } from '../../lib/stellar';
import { redisCache } from '../../lib/redis';
import { createLogger } from '../../lib/logger';
import { deliverUserAlert, escapeTelegramHtml } from './alert-delivery';

const log = createLogger({ module: 'TrustlineSentinel' });

/** Trustline flag bit values (CAP-0018 / CAP-0035). */
export const TRUSTLINE_FLAG_AUTHORIZED = 1;
export const TRUSTLINE_FLAG_AUTHORIZED_TO_MAINTAIN_LIABILITIES = 2;

/** A `change_trust` limit of int64 max (in stroops) means "no cap". */
const UNLIMITED_TRUSTLINE_LIMIT = '922337203685.4775807';

export type TrustlineAlertType =
  | 'CLAWBACK'
  | 'CLAWBACK_CLAIMABLE_BALANCE'
  | 'AUTHORIZATION_REVOKED'
  | 'AUTHORIZATION_MAINTAIN_LIABILITIES_ONLY'
  | 'TRUSTLINE_REMOVED'
  | 'TRUSTLINE_LIMIT_CHANGED';

export type TrustlineAlertSeverity = 'CRITICAL' | 'WARNING';

export interface TrustlineAlert {
  eventType: TrustlineAlertType;
  severity: TrustlineAlertSeverity;
  /** The monitored account that is affected. */
  account: string;
  operationId: string;
  transactionHash?: string;
  /** Account that submitted the operation (the issuer for clawback / flag ops). */
  sourceAccount?: string;
  assetCode: string;
  assetIssuer?: string;
  amount?: string;
  limit?: string;
  balanceId?: string;
  message: string;
  occurredAt: string;
}

/** The subset of a Horizon operation record the sentinel reads. */
export interface TrustlineOperation {
  id?: string;
  paging_token?: string;
  type: string;
  created_at?: string;
  transaction_hash?: string;
  transaction_successful?: boolean;
  source_account?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  trustor?: string;
  trustee?: string;
  from?: string;
  amount?: string;
  limit?: string;
  liquidity_pool_id?: string;
  balance_id?: string;
  authorize?: boolean;
  authorize_to_maintain_liabilities?: boolean;
  set_flags?: number[];
  clear_flags?: number[];
  set_flags_s?: string[];
  clear_flags_s?: string[];
}

export interface TrackedClaimableBalance {
  id: string;
  claimants: string[];
  assetCode: string;
  assetIssuer?: string;
  amount?: string;
}

export const TRUSTLINE_OPERATION_TYPES = new Set([
  'change_trust',
  'allow_trust',
  'set_trust_line_flags',
  'clawback',
  'clawback_claimable_balance',
]);

function flagSet(numeric: number[] | undefined, named: string[] | undefined) {
  const names = new Set((named ?? []).map((name) => name.toLowerCase()));
  const has = (bit: number, ...aliases: string[]) =>
    (numeric ?? []).includes(bit) || aliases.some((alias) => names.has(alias));
  return {
    authorized: has(TRUSTLINE_FLAG_AUTHORIZED, 'authorized'),
    // Horizon has historically spelled this flag "liabilites"; accept both.
    maintainLiabilities: has(
      TRUSTLINE_FLAG_AUTHORIZED_TO_MAINTAIN_LIABILITIES,
      'authorized_to_maintain_liabilities',
      'authorized_to_maintain_liabilites',
    ),
  };
}

function short(address: string | undefined): string {
  return address ? `${address.slice(0, 8)}...` : 'unknown';
}

/**
 * Pure assessment of trustline-affecting operations against a set of
 * monitored accounts. Regulated assets (EURC, USDS, ...) let their issuer
 * freeze a trustline or claw funds back; the holder needs to hear about it
 * immediately, so these are CRITICAL alerts.
 */
export class TrustlineSentinel {
  private monitored = new Set<string>();
  private claimableBalances = new Map<string, TrackedClaimableBalance>();

  constructor(monitoredAccounts: Iterable<string> = []) {
    this.setMonitoredAccounts(monitoredAccounts);
  }

  setMonitoredAccounts(accounts: Iterable<string>): void {
    this.monitored = new Set(accounts);
  }

  isMonitored(account: string | undefined): boolean {
    return !!account && this.monitored.has(account);
  }

  /** Remembers which monitored accounts can claim a balance, so a later clawback can be attributed. */
  trackClaimableBalance(balance: TrackedClaimableBalance): void {
    const claimants = balance.claimants.filter((claimant) => this.monitored.has(claimant));
    if (claimants.length === 0) return;
    this.claimableBalances.set(balance.id, { ...balance, claimants });
  }

  untrackClaimableBalance(balanceId: string): void {
    this.claimableBalances.delete(balanceId);
  }

  trackedClaimableBalanceIds(): string[] {
    return Array.from(this.claimableBalances.keys());
  }

  /** Returns one alert per affected monitored account (empty when nothing is relevant). */
  assess(op: TrustlineOperation): TrustlineAlert[] {
    if (op.transaction_successful === false) return [];

    switch (op.type) {
      case 'clawback':
        return this.assessClawback(op);
      case 'clawback_claimable_balance':
        return this.assessClawbackClaimableBalance(op);
      case 'set_trust_line_flags':
        return this.assessFlags(op, flagSet(op.set_flags, op.set_flags_s), flagSet(op.clear_flags, op.clear_flags_s));
      case 'allow_trust':
        return this.assessAllowTrust(op);
      case 'change_trust':
        return this.assessChangeTrust(op);
      default:
        return [];
    }
  }

  private base(op: TrustlineOperation, account: string) {
    return {
      account,
      operationId: op.id ?? op.paging_token ?? '',
      transactionHash: op.transaction_hash,
      sourceAccount: op.source_account,
      assetCode: op.asset_code ?? (op.asset_type === 'native' ? 'XLM' : 'UNKNOWN'),
      assetIssuer: op.asset_issuer,
      occurredAt: op.created_at ?? new Date().toISOString(),
    };
  }

  private assessClawback(op: TrustlineOperation): TrustlineAlert[] {
    if (!op.from || !this.monitored.has(op.from)) return [];
    const base = this.base(op, op.from);
    return [
      {
        ...base,
        eventType: 'CLAWBACK',
        severity: 'CRITICAL',
        amount: op.amount,
        message:
          `Issuer ${short(op.source_account)} clawed back ${op.amount ?? 'an unspecified amount of'} ` +
          `${base.assetCode} from monitored account ${short(op.from)}.`,
      },
    ];
  }

  private assessClawbackClaimableBalance(op: TrustlineOperation): TrustlineAlert[] {
    const tracked = op.balance_id ? this.claimableBalances.get(op.balance_id) : undefined;
    if (!tracked) return [];

    return tracked.claimants
      .filter((claimant) => this.monitored.has(claimant))
      .map((claimant) => {
        const base = this.base(op, claimant);
        return {
          ...base,
          assetCode: tracked.assetCode,
          assetIssuer: tracked.assetIssuer ?? op.asset_issuer,
          eventType: 'CLAWBACK_CLAIMABLE_BALANCE' as const,
          severity: 'CRITICAL' as const,
          amount: tracked.amount,
          balanceId: op.balance_id,
          message:
            `Issuer ${short(op.source_account)} clawed back claimable balance ${short(op.balance_id)} ` +
            `(${tracked.amount ?? '?'} ${tracked.assetCode}) that monitored account ${short(claimant)} could claim.`,
        };
      });
  }

  private assessFlags(
    op: TrustlineOperation,
    set: ReturnType<typeof flagSet>,
    clear: ReturnType<typeof flagSet>,
  ): TrustlineAlert[] {
    if (!op.trustor || !this.monitored.has(op.trustor)) return [];
    const base = this.base(op, op.trustor);

    // Dropping AUTHORIZED (or fully de-authorizing) freezes the holder's trustline.
    const deauthorized = clear.authorized || (clear.maintainLiabilities && !set.authorized && !set.maintainLiabilities);
    if (deauthorized && !set.authorized) {
      const downgraded = set.maintainLiabilities;
      return [
        {
          ...base,
          eventType: downgraded ? 'AUTHORIZATION_MAINTAIN_LIABILITIES_ONLY' : 'AUTHORIZATION_REVOKED',
          severity: 'CRITICAL',
          message: downgraded
            ? `Issuer ${short(op.source_account)} revoked AUTHORIZED and set AUTHORIZED_TO_MAINTAIN_LIABILITIES ` +
              `on ${base.assetCode} for ${short(op.trustor)}; the account can no longer send or receive this asset.`
            : `Issuer ${short(op.source_account)} revoked trustline authorization for ${base.assetCode} ` +
              `held by ${short(op.trustor)}; the asset is frozen.`,
        },
      ];
    }

    if (set.maintainLiabilities && !set.authorized) {
      return [
        {
          ...base,
          eventType: 'AUTHORIZATION_MAINTAIN_LIABILITIES_ONLY',
          severity: 'CRITICAL',
          message:
            `Issuer ${short(op.source_account)} limited ${base.assetCode} trustline of ${short(op.trustor)} ` +
            `to AUTHORIZED_TO_MAINTAIN_LIABILITIES; the account can no longer send or receive this asset.`,
        },
      ];
    }

    return [];
  }

  private assessAllowTrust(op: TrustlineOperation): TrustlineAlert[] {
    // allow_trust is the pre-CAP-35 form of set_trust_line_flags.
    return this.assessFlags(
      op,
      {
        authorized: op.authorize === true,
        maintainLiabilities: op.authorize_to_maintain_liabilities === true,
      },
      {
        authorized: op.authorize === false,
        maintainLiabilities: false,
      },
    );
  }

  private assessChangeTrust(op: TrustlineOperation): TrustlineAlert[] {
    // Liquidity pool share trustlines are not issuer-controlled assets.
    if (op.liquidity_pool_id || op.asset_type === 'liquidity_pool_shares') return [];

    const account = op.trustor ?? op.source_account;
    if (!account || !this.monitored.has(account) || op.limit === undefined) return [];

    const limit = Number(op.limit) === 0 ? '0.0000000' : op.limit;
    const base = this.base(op, account);

    if (Number(limit) === 0) {
      return [
        {
          ...base,
          eventType: 'TRUSTLINE_REMOVED',
          severity: 'CRITICAL',
          limit,
          message: `Trustline for ${base.assetCode} on monitored account ${short(account)} was removed (limit set to 0).`,
        },
      ];
    }

    // Raising a trustline back to "unlimited" is routine (adding a trustline).
    if (op.limit === UNLIMITED_TRUSTLINE_LIMIT) return [];

    return [
      {
        ...base,
        eventType: 'TRUSTLINE_LIMIT_CHANGED',
        severity: 'WARNING',
        limit: op.limit,
        message: `Trustline limit for ${base.assetCode} on monitored account ${short(account)} was set to ${op.limit}.`,
      },
    ];
  }
}

// ── Delivery ────────────────────────────────────────────────────────────────

export function buildTrustlineWebhookPayload(alert: TrustlineAlert) {
  return { event: 'trustline.alert', ...alert };
}

export function buildTrustlineTelegramMessage(alert: TrustlineAlert): string {
  const tag = alert.severity === 'CRITICAL' ? '🚨 <b>CRITICAL</b>' : '⚠️ <b>WARNING</b>';
  return [
    `${tag} — Stellar trustline alert`,
    `<b>Event:</b> ${escapeTelegramHtml(alert.eventType)}`,
    `<b>Asset:</b> ${escapeTelegramHtml(alert.assetCode)}`,
    `<b>Account:</b> <code>${escapeTelegramHtml(alert.account)}</code>`,
    escapeTelegramHtml(alert.message),
    alert.transactionHash ? `<b>Transaction:</b> <code>${escapeTelegramHtml(alert.transactionHash)}</code>` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export type TrustlineAlertNotifier = (alert: TrustlineAlert) => Promise<void> | void;

/** Delivers an alert to the owner(s) of the affected wallet (webhooks + Telegram). */
export const deliverTrustlineAlert: TrustlineAlertNotifier = async (alert) => {
  const wallets = await prisma.wallet.findMany({
    where: { publicKey: alert.account, deletedAt: null },
    select: { userId: true },
  });

  const payload = buildTrustlineWebhookPayload(alert);
  const text = buildTrustlineTelegramMessage(alert);
  for (const userId of new Set(wallets.map((wallet) => wallet.userId))) {
    await deliverUserAlert(userId, payload, text);
  }
};

// ── Polling pass (called from the watcher worker) ───────────────────────────

const CURSOR_KEY_PREFIX = 'trustline-sentinel:cursor:';
const ALERT_KEY_PREFIX = 'trustline-sentinel:alert:';
const ALERT_DEDUPE_TTL_SECONDS = 30 * 24 * 60 * 60;
const OPERATIONS_PAGE_SIZE = 100;

export const trustlineSentinel = new TrustlineSentinel();

/** Emits an alert once per (operation, account); safe across restarts and overlapping passes. */
async function emitOnce(alert: TrustlineAlert, notify: TrustlineAlertNotifier): Promise<boolean> {
  const first = await redisCache.setNx(
    `${ALERT_KEY_PREFIX}${alert.operationId}:${alert.account}`,
    '1',
    ALERT_DEDUPE_TTL_SECONDS,
  );
  if (!first) return false;

  log.warn(`[${alert.severity}] ${alert.eventType}: ${alert.message}`);
  await notify(alert);
  return true;
}

async function scanAccountOperations(
  publicKey: string,
  sentinel: TrustlineSentinel,
  notify: TrustlineAlertNotifier,
): Promise<number> {
  const cursorKey = `${CURSOR_KEY_PREFIX}${publicKey}`;
  let cursor = await redisCache.get(cursorKey);

  if (!cursor) {
    // First sight of this account: start from "now" so history is not replayed as fresh alerts.
    const latest = await stellar.getLatestOperationPagingToken(publicKey);
    if (latest.ok) await redisCache.set(cursorKey, latest.token ?? '0');
    return 0;
  }

  let emitted = 0;
  const result = await stellar.getAccountOperationsSince(publicKey, cursor, OPERATIONS_PAGE_SIZE);
  if (!result.ok) return 0;

  for (const record of result.records as TrustlineOperation[]) {
    if (TRUSTLINE_OPERATION_TYPES.has(record.type)) {
      for (const alert of sentinel.assess(record)) {
        if (await emitOnce(alert, notify)) emitted += 1;
      }
    }
    if (record.paging_token) cursor = record.paging_token;
  }

  await redisCache.set(cursorKey, cursor);
  return emitted;
}

/**
 * Claimable balances that a monitored account can claim are remembered, then
 * checked for a clawback_claimable_balance operation (Horizon lists a
 * balance's operations even after it has been deleted).
 */
async function scanClaimableBalances(
  publicKeys: string[],
  sentinel: TrustlineSentinel,
  notify: TrustlineAlertNotifier,
): Promise<number> {
  for (const publicKey of publicKeys) {
    for (const balance of await stellar.getClaimableBalancesForClaimant(publicKey)) {
      sentinel.trackClaimableBalance(balance);
    }
  }

  let emitted = 0;
  for (const balanceId of sentinel.trackedClaimableBalanceIds()) {
    const ops = await stellar.getClaimableBalanceOperations(balanceId);
    for (const record of ops as TrustlineOperation[]) {
      if (record.type === 'clawback_claimable_balance') {
        for (const alert of sentinel.assess({ ...record, balance_id: record.balance_id ?? balanceId })) {
          if (await emitOnce(alert, notify)) emitted += 1;
        }
        sentinel.untrackClaimableBalance(balanceId);
      } else if (record.type === 'claim_claimable_balance') {
        sentinel.untrackClaimableBalance(balanceId);
      }
    }
  }
  return emitted;
}

/**
 * One sentinel pass over the monitored wallets. Each account's failure is
 * isolated so a single unreachable account never stalls the rest.
 */
export async function runTrustlineSentinelPass(
  publicKeys: string[],
  notify: TrustlineAlertNotifier = deliverTrustlineAlert,
  sentinel: TrustlineSentinel = trustlineSentinel,
): Promise<number> {
  sentinel.setMonitoredAccounts(publicKeys);

  let emitted = 0;
  for (const publicKey of publicKeys) {
    try {
      emitted += await scanAccountOperations(publicKey, sentinel, notify);
    } catch (err: unknown) {
      log.warn(`Operation scan failed for ${short(publicKey)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    emitted += await scanClaimableBalances(publicKeys, sentinel, notify);
  } catch (err: unknown) {
    log.warn(`Claimable balance scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return emitted;
}
