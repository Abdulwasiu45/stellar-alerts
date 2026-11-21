import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma', () => ({ prisma: {} }));
vi.mock('../../../lib/stellar', () => ({ stellar: {} }));
vi.mock('../../../lib/redis', () => ({ redisCache: {} }));
vi.mock('../../../lib/queue', () => ({ dispatchWebhookAndLog: vi.fn() }));

import { TrustlineSentinel, type TrustlineOperation } from '../trustline-sentinel.service';

const ISSUER = 'GAISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const HOLDER = 'GBHOLDERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const OTHER = 'GCOTHERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

const op = (overrides: Partial<TrustlineOperation>): TrustlineOperation => ({
  id: 'op-1',
  type: 'set_trust_line_flags',
  source_account: ISSUER,
  asset_code: 'EURC',
  asset_issuer: ISSUER,
  created_at: '2026-11-21T10:00:00Z',
  transaction_hash: 'abc123',
  ...overrides,
});

describe('TrustlineSentinel', () => {
  const sentinel = new TrustlineSentinel([HOLDER]);

  it('flags a clawback against a monitored account as CRITICAL', () => {
    const [alert] = sentinel.assess(op({ type: 'clawback', from: HOLDER, amount: '50.0000000' }));
    expect(alert).toMatchObject({ eventType: 'CLAWBACK', severity: 'CRITICAL', account: HOLDER, amount: '50.0000000' });
  });

  it('ignores a clawback against an unmonitored account', () => {
    expect(sentinel.assess(op({ type: 'clawback', from: OTHER, amount: '1' }))).toEqual([]);
  });

  it('flags revoking AUTHORIZED via set_trust_line_flags', () => {
    const [alert] = sentinel.assess(op({ trustor: HOLDER, clear_flags: [1], clear_flags_s: ['authorized'] }));
    expect(alert).toMatchObject({ eventType: 'AUTHORIZATION_REVOKED', severity: 'CRITICAL' });
  });

  it('flags setting AUTHORIZED_TO_MAINTAIN_LIABILITIES', () => {
    const [alert] = sentinel.assess(
      op({ trustor: HOLDER, set_flags: [2], clear_flags: [1] }),
    );
    expect(alert).toMatchObject({ eventType: 'AUTHORIZATION_MAINTAIN_LIABILITIES_ONLY', severity: 'CRITICAL' });

    const [onlySet] = sentinel.assess(op({ trustor: HOLDER, set_flags_s: ['authorized_to_maintain_liabilites'] }));
    expect(onlySet.eventType).toBe('AUTHORIZATION_MAINTAIN_LIABILITIES_ONLY');
  });

  it('does not alert when a trustline is (re)authorized', () => {
    expect(sentinel.assess(op({ trustor: HOLDER, set_flags: [1] }))).toEqual([]);
  });

  it('treats legacy allow_trust with authorize=false as a revocation', () => {
    const [alert] = sentinel.assess(op({ type: 'allow_trust', trustor: HOLDER, authorize: false }));
    expect(alert.eventType).toBe('AUTHORIZATION_REVOKED');
  });

  it('flags trustline removal and finite limits, but not an unlimited trustline', () => {
    const removed = sentinel.assess(op({ type: 'change_trust', trustor: HOLDER, source_account: HOLDER, limit: '0.0000000' }));
    expect(removed[0]).toMatchObject({ eventType: 'TRUSTLINE_REMOVED', severity: 'CRITICAL' });

    const capped = sentinel.assess(op({ type: 'change_trust', trustor: HOLDER, source_account: HOLDER, limit: '100.0000000' }));
    expect(capped[0]).toMatchObject({ eventType: 'TRUSTLINE_LIMIT_CHANGED', severity: 'WARNING' });

    const unlimited = sentinel.assess(
      op({ type: 'change_trust', trustor: HOLDER, source_account: HOLDER, limit: '922337203685.4775807' }),
    );
    expect(unlimited).toEqual([]);
  });

  it('attributes clawback_claimable_balance to monitored claimants of a tracked balance', () => {
    const tracked = new TrustlineSentinel([HOLDER]);
    tracked.trackClaimableBalance({ id: 'cb1', claimants: [HOLDER, OTHER], assetCode: 'EURC', assetIssuer: ISSUER, amount: '9' });

    const alerts = tracked.assess(op({ type: 'clawback_claimable_balance', balance_id: 'cb1' }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ eventType: 'CLAWBACK_CLAIMABLE_BALANCE', account: HOLDER, severity: 'CRITICAL', balanceId: 'cb1' });

    expect(tracked.assess(op({ type: 'clawback_claimable_balance', balance_id: 'unknown' }))).toEqual([]);
  });

  it('skips operations from failed transactions', () => {
    expect(sentinel.assess(op({ type: 'clawback', from: HOLDER, transaction_successful: false }))).toEqual([]);
  });
});
