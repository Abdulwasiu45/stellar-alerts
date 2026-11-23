import { beforeEach, describe, expect, it, vi } from 'vitest';

const { payments, prismaMock } = vi.hoisted(() => {
  const payments: any[] = [];
  const prismaMock = {
    payment: { findMany: vi.fn(), deleteMany: vi.fn() },
    paymentArchive: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
    sorobanEventSnapshot: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
    archiveCursor: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn() },
    archiveManifest: { upsert: vi.fn() },
  };
  return { payments, prismaMock };
});

vi.mock('../../lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('../../modules/maintenance/partition.service', () => ({ partitionService: {} }));

import { LedgerArchivalWorker, PAYMENTS_DATASET } from '../archival.worker';
import { sha256Hex, type ArchiveStorage } from '../../lib/storage';

const payment = (id: string, receivedAt: string) => ({
  id,
  walletId: 'w1',
  txHash: `tx-${id}`,
  fromAddress: 'GFROM',
  amount: { toString: () => '12.3400000' },
  asset: 'XLM',
  assetIssuer: null,
  memo: null,
  receivedAt: new Date(receivedAt),
  createdAt: new Date(receivedAt),
});

function memoryStorage(options: { corrupt?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const storage: ArchiveStorage = {
    provider: 'local',
    location: 'memory',
    async put(key, body) {
      objects.set(key, options.corrupt ? Buffer.from('corrupted') : body);
    },
    async verify(key, expected) {
      const body = objects.get(key);
      return !!body && body.length === expected.size && sha256Hex(body) === expected.sha256Hex;
    },
  };
  return { storage, objects };
}

const encode = async (columns: any[]) => Buffer.from(JSON.stringify(columns.map((c) => [c.name, c.data])));

function makeWorker(storage: ArchiveStorage) {
  return new LedgerArchivalWorker({
    storage,
    encode,
    disableLock: true,
    now: () => new Date('2026-11-21T00:00:00Z'),
    config: { datasets: [PAYMENTS_DATASET], batchSize: 100, prefix: 'archive', prune: true },
  });
}

describe('LedgerArchivalWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    payments.length = 0;
    prismaMock.payment.findMany.mockImplementation(async () => payments);
    prismaMock.payment.deleteMany.mockResolvedValue({ count: 3 });
    prismaMock.paymentArchive.findMany.mockResolvedValue([]);
  });

  it('partitions rows by year/month, verifies each upload and then prunes', async () => {
    payments.push(
      payment('p1', '2026-06-10T00:00:00Z'),
      payment('p2', '2026-06-20T00:00:00Z'),
      payment('p3', '2026-07-02T00:00:00Z'),
    );
    const { storage, objects } = memoryStorage();

    const result = await makeWorker(storage).run();

    expect(result.success).toBe(true);
    const keys = [...objects.keys()];
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => /^archive\/payments\/year=2026\/month=06\/part-[0-9a-f]{16}\.parquet$/.test(k))).toBe(true);
    expect(keys.some((k) => /^archive\/payments\/year=2026\/month=07\/part-[0-9a-f]{16}\.parquet$/.test(k))).toBe(true);

    expect(prismaMock.archiveManifest.upsert).toHaveBeenCalledTimes(2);
    const manifest = prismaMock.archiveManifest.upsert.mock.calls[0][0].create;
    expect(manifest).toMatchObject({ dataset: 'payments', year: 2026, month: 6, rowCount: 2 });
    expect(manifest.sha256).toBe(sha256Hex(objects.get(manifest.objectKey)!));

    // Only rows that are not linked into the checksum chain are deletable.
    expect(prismaMock.payment.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'p2', 'p3'] }, checksum: { is: null } },
    });
    expect(prismaMock.archiveCursor.upsert).toHaveBeenCalled();
  });

  it('never prunes or advances the cursor when checksum verification fails', async () => {
    payments.push(payment('p1', '2026-06-10T00:00:00Z'));
    const { storage } = memoryStorage({ corrupt: true });

    const result = await makeWorker(storage).run();

    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/failed SHA-256 verification/);
    expect(prismaMock.payment.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.archiveCursor.upsert).not.toHaveBeenCalled();
    expect(prismaMock.archiveManifest.upsert).not.toHaveBeenCalled();
  });

  it('skips the upload when an identical verified object already exists', async () => {
    payments.push(payment('p1', '2026-06-10T00:00:00Z'));
    const { storage } = memoryStorage();
    const putSpy = vi.spyOn(storage, 'put');
    const worker = makeWorker(storage);

    await worker.run();
    await worker.run();

    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps copy-only mode from deleting anything', async () => {
    payments.push(payment('p1', '2026-06-10T00:00:00Z'));
    const { storage } = memoryStorage();
    const worker = new LedgerArchivalWorker({
      storage,
      encode,
      disableLock: true,
      now: () => new Date('2026-11-21T00:00:00Z'),
      config: { datasets: [PAYMENTS_DATASET], batchSize: 100, prefix: 'archive', prune: false },
    });

    await worker.run();

    expect(prismaMock.payment.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.archiveManifest.upsert).toHaveBeenCalled();
  });
});
