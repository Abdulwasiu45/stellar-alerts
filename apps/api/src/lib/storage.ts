import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { env } from '../config/env';

/**
 * Object storage for the cold-tier ledger archive.
 *
 * The same interface is backed by:
 *  - `s3`    Amazon S3 (or any S3-compatible endpoint such as MinIO / R2)
 *  - `gcs`   Google Cloud Storage through its S3-compatible XML API
 *            (HMAC interoperability keys), so one client covers both clouds
 *  - `local` a directory on disk, for development and tests
 *
 * Every upload carries its SHA-256 and `verify()` proves the stored object
 * still matches it. Archival only prunes hot database rows after `verify()`
 * succeeds.
 */

export type ArchiveStorageProvider = 'local' | 's3' | 'gcs';

export interface ArchiveObjectExpectation {
  sha256Hex: string;
  size: number;
}

export interface ArchiveStorage {
  readonly provider: ArchiveStorageProvider;
  /** Bucket name (or directory for the local provider) — recorded in the manifest. */
  readonly location: string;
  put(key: string, body: Buffer, options: { sha256Hex: string; contentType?: string }): Promise<void>;
  /** True only when the stored object has exactly the expected size and SHA-256. */
  verify(key: string, expected: ArchiveObjectExpectation): Promise<boolean>;
}

export function sha256Hex(data: Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256Base64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

/** Keys are server-generated, but reject anything that could escape the prefix anyway. */
export function assertSafeArchiveKey(key: string): void {
  if (!key || key.startsWith('/') || key.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new Error(`Refusing unsafe archive key: ${key}`);
  }
}

export class LocalArchiveStorage implements ArchiveStorage {
  readonly provider = 'local' as const;
  readonly location: string;

  constructor(directory: string = env.ARCHIVE_LOCAL_DIR || path.join(os.tmpdir(), 'stellar-alerts-archive')) {
    this.location = directory;
  }

  private resolve(key: string): string {
    assertSafeArchiveKey(key);
    return path.join(this.location, ...key.split('/'));
  }

  async put(key: string, body: Buffer): Promise<void> {
    const finalPath = this.resolve(key);
    const tmpPath = `${finalPath}.tmp`;
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(tmpPath, body, { mode: 0o600 });
      await fs.rename(tmpPath, finalPath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true });
      throw err;
    }
  }

  async verify(key: string, expected: ArchiveObjectExpectation): Promise<boolean> {
    try {
      const data = await fs.readFile(this.resolve(key));
      return data.length === expected.size && sha256Hex(data) === expected.sha256Hex;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
  }
}

export interface S3ArchiveStorageOptions {
  provider: 's3' | 'gcs';
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

const GCS_ENDPOINT = 'https://storage.googleapis.com';

export class S3ArchiveStorage implements ArchiveStorage {
  readonly provider: 's3' | 'gcs';
  readonly location: string;
  private clientPromise: Promise<{ client: any; sdk: typeof import('@aws-sdk/client-s3') }> | null = null;

  constructor(private readonly options: S3ArchiveStorageOptions) {
    if (!options.bucket) {
      throw new Error('ARCHIVE_BUCKET is required for the s3 / gcs archive storage providers');
    }
    this.provider = options.provider;
    this.location = options.bucket;
  }

  /** Real S3 validates `x-amz-checksum-sha256` itself; S3-compatible stores may not. */
  private get supportsServerChecksum(): boolean {
    return this.options.provider === 's3' && !this.options.endpoint;
  }

  // Loaded lazily so importing the worker never pulls the AWS SDK in unless archives are on.
  private getClient() {
    if (!this.clientPromise) {
      this.clientPromise = import('@aws-sdk/client-s3').then((sdk) => {
        const { provider, region, endpoint, accessKeyId, secretAccessKey } = this.options;
        const resolvedEndpoint = endpoint || (provider === 'gcs' ? GCS_ENDPOINT : undefined);
        const client = new sdk.S3Client({
          region: region || 'us-east-1',
          ...(resolvedEndpoint ? { endpoint: resolvedEndpoint, forcePathStyle: true } : {}),
          ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
          // GCS rejects the SDK's default CRC32 trailer checksums; only send them when required.
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        });
        return { client, sdk };
      });
    }
    return this.clientPromise;
  }

  async put(key: string, body: Buffer, options: { sha256Hex: string; contentType?: string }): Promise<void> {
    assertSafeArchiveKey(key);
    const { client, sdk } = await this.getClient();
    await client.send(
      new sdk.PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType ?? 'application/octet-stream',
        Metadata: { sha256: options.sha256Hex },
        ...(this.supportsServerChecksum ? { ChecksumSHA256: sha256Base64(options.sha256Hex) } : {}),
      }),
    );
  }

  async verify(key: string, expected: ArchiveObjectExpectation): Promise<boolean> {
    assertSafeArchiveKey(key);
    const { client, sdk } = await this.getClient();

    let head: any;
    try {
      head = await client.send(
        new sdk.HeadObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          ...(this.supportsServerChecksum ? { ChecksumMode: 'ENABLED' } : {}),
        }),
      );
    } catch (err: any) {
      if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }

    if (head.ContentLength !== expected.size) return false;

    // S3 returns the checksum it computed itself, which is independent of what we sent.
    if (head.ChecksumSHA256) {
      return head.ChecksumSHA256 === sha256Base64(expected.sha256Hex);
    }

    // No server-side checksum (GCS, MinIO, ...): read the object back and hash it.
    const object = await client.send(new sdk.GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    const bytes = await object.Body?.transformToByteArray();
    return !!bytes && bytes.length === expected.size && sha256Hex(bytes) === expected.sha256Hex;
  }
}

/** Builds the archive storage selected by the ARCHIVE_* environment variables. */
export function createArchiveStorage(): ArchiveStorage {
  const provider = env.ARCHIVE_STORAGE_PROVIDER;
  if (provider === 'local') {
    return new LocalArchiveStorage();
  }

  return new S3ArchiveStorage({
    provider,
    bucket: env.ARCHIVE_BUCKET,
    region: env.ARCHIVE_REGION,
    endpoint: env.ARCHIVE_ENDPOINT || undefined,
    accessKeyId: env.ARCHIVE_ACCESS_KEY_ID || undefined,
    secretAccessKey: env.ARCHIVE_SECRET_ACCESS_KEY || undefined,
  });
}
