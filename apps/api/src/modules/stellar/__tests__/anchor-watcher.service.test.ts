import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    anchorTransactionWatch: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn((args: any) => ({ op: 'update', args })),
      updateMany: vi.fn(),
    },
    anchorTransactionEvent: { create: vi.fn((args: any) => ({ op: 'event', args })) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
}));

vi.mock('../../../lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../../lib/queue', () => ({ dispatchWebhookAndLog: vi.fn() }));

import {
  AnchorLifecycleWatcher,
  isRegression,
  normalizeMemo,
  unifiedAnchorState,
  type AnchorWatchRecord,
} from '../anchor-watcher.service';

const ANCHOR_ACCOUNT = 'GANCHORACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

const watch = (overrides: Partial<AnchorWatchRecord> = {}): AnchorWatchRecord => ({
  id: 'w1',
  userId: 'u1',
  anchorEndpoint: 'https://anchor.example.com/sep24',
  anchorTxId: 'anchor-1',
  protocol: 'sep24',
  lastKnownStatus: null,
  ...overrides,
});

function makeWatcher(status: any) {
  const notify = vi.fn();
  const watcher = new AnchorLifecycleWatcher({
    fetchStatus: vi.fn().mockResolvedValue(status),
    notify,
    validateEndpoint: async () => undefined,
    authToken: () => undefined,
  });
  return { watcher, notify };
}

describe('unified state and transitions', () => {
  it('maps SEP-24 and SEP-31 statuses to one vocabulary', () => {
    expect(unifiedAnchorState('pending_user_transfer_start')).toBe('AWAITING_USER');
    expect(unifiedAnchorState('pending_anchor')).toBe('AWAITING_ANCHOR');
    expect(unifiedAnchorState('pending_trust')).toBe('ACTION_REQUIRED');
    expect(unifiedAnchorState('completed')).toBe('COMPLETED');
    expect(unifiedAnchorState('too_small')).toBe('FAILED');
    expect(unifiedAnchorState('some_future_status')).toBe('AWAITING_ANCHOR');
  });

  it('allows the expected forward path and flags regressions', () => {
    expect(isRegression('sep24', null, 'pending_user_transfer_start')).toBe(false);
    expect(isRegression('sep24', 'pending_user_transfer_start', 'pending_anchor')).toBe(false);
    expect(isRegression('sep24', 'pending_anchor', 'completed')).toBe(false);
    // skipping intermediate states is normal
    expect(isRegression('sep24', 'incomplete', 'completed')).toBe(false);
    expect(isRegression('sep24', 'pending_anchor', 'pending_user_transfer_start')).toBe(true);
    expect(isRegression('sep24', 'completed', 'pending_anchor')).toBe(true);
  });

  it('normalizes memo ids but leaves text memos alone', () => {
    expect(normalizeMemo('000123', 'id')).toBe('123');
    expect(normalizeMemo('000123', 'text')).toBe('000123');
  });
});

describe('AnchorLifecycleWatcher.pollWatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records each transition with its history event and notifies', async () => {
    const { watcher, notify } = makeWatcher({
      id: 'anchor-1',
      status: 'pending_anchor',
      kind: 'withdrawal',
      anchorAccount: ANCHOR_ACCOUNT,
      memo: '42',
      memoType: 'id',
    });

    await watcher.pollWatch(watch({ lastKnownStatus: 'pending_user_transfer_start' }));

    const [ops] = prismaMock.$transaction.mock.calls[0] as [any[]];
    expect(ops[0].args.data).toMatchObject({
      lastKnownStatus: 'pending_anchor',
      unifiedState: 'AWAITING_ANCHOR',
      kind: 'withdrawal',
      anchorAccount: ANCHOR_ACCOUNT,
      memo: '42',
    });
    expect(ops[1].args.data).toMatchObject({
      type: 'STATUS_CHANGED',
      fromStatus: 'pending_user_transfer_start',
      toStatus: 'pending_anchor',
      anomaly: false,
    });
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'anchor.transfer.status_changed', status: 'pending_anchor', state: 'AWAITING_ANCHOR' }),
    );
  });

  it('does not write or notify when the status is unchanged', async () => {
    const { watcher, notify } = makeWatcher({ id: 'anchor-1', status: 'pending_anchor' });

    await watcher.pollWatch(watch({ lastKnownStatus: 'pending_anchor' }));

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('flags a backwards transition as an anomaly', async () => {
    const { watcher } = makeWatcher({ id: 'anchor-1', status: 'pending_anchor' });

    await watcher.pollWatch(watch({ lastKnownStatus: 'completed' }));

    const [ops] = prismaMock.$transaction.mock.calls[0] as [any[]];
    expect(ops[1].args.data.anomaly).toBe(true);
  });

  it('leaves the watch untouched when the anchor is unreachable', async () => {
    const { watcher, notify } = makeWatcher(null);

    expect(await watcher.pollWatch(watch())).toBeNull();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('AnchorLifecycleWatcher.correlatePayment', () => {
  beforeEach(() => vi.clearAllMocks());

  const registered = {
    id: 'w1',
    userId: 'u1',
    anchorEndpoint: 'https://anchor.example.com/sep24',
    anchorTxId: 'anchor-1',
    protocol: 'sep24',
    kind: 'withdrawal',
    lastKnownStatus: 'pending_anchor',
    anchorAccount: ANCHOR_ACCOUNT,
    memo: '42',
    memoType: 'id',
    stellarTxHash: null,
  };

  it('links a memo-matching payment to the anchor account to the registered transfer', async () => {
    prismaMock.anchorTransactionWatch.findMany.mockResolvedValue([registered]);
    prismaMock.anchorTransactionWatch.updateMany.mockResolvedValue({ count: 1 });
    const { watcher, notify } = makeWatcher(null);

    const matched = await watcher.correlatePayment({
      txHash: 'stellar-hash',
      from: 'GUSER',
      to: ANCHOR_ACCOUNT,
      memo: '0042',
      memoType: 'id',
      userId: 'u1',
    });

    expect(matched).toBe('w1');
    expect(prismaMock.anchorTransactionWatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'w1', stellarTxHash: null },
      data: { stellarTxHash: 'stellar-hash' },
    });
    expect(prismaMock.anchorTransactionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'STELLAR_TX_MATCHED', stellarTxHash: 'stellar-hash' }),
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: 'anchor.transfer.stellar_matched' }));
  });

  it('does not match a different memo', async () => {
    prismaMock.anchorTransactionWatch.findMany.mockResolvedValue([registered]);
    const { watcher } = makeWatcher(null);

    const matched = await watcher.correlatePayment({
      txHash: 'h',
      from: 'GUSER',
      to: ANCHOR_ACCOUNT,
      memo: '99',
      memoType: 'id',
      userId: 'u1',
    });

    expect(matched).toBeNull();
    expect(prismaMock.anchorTransactionWatch.updateMany).not.toHaveBeenCalled();
  });

  it('requires the payment to belong to the registering user', async () => {
    const { watcher } = makeWatcher(null);

    expect(await watcher.correlatePayment({ txHash: 'h', from: 'a', to: ANCHOR_ACCOUNT, memo: '42' })).toBeNull();
    expect(prismaMock.anchorTransactionWatch.findMany).not.toHaveBeenCalled();
  });

  it('does not double-match when another ingestion path already claimed the payment', async () => {
    prismaMock.anchorTransactionWatch.findMany.mockResolvedValue([registered]);
    prismaMock.anchorTransactionWatch.updateMany.mockResolvedValue({ count: 0 });
    const { watcher, notify } = makeWatcher(null);

    const matched = await watcher.correlatePayment({
      txHash: 'h',
      from: 'GUSER',
      to: ANCHOR_ACCOUNT,
      memo: '42',
      memoType: 'id',
      userId: 'u1',
    });

    expect(matched).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });
});
