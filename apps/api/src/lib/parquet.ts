/**
 * Parquet encoding for the cold-tier archive.
 *
 * `hyparquet-writer` is published as an ES module only. The API compiles to
 * CommonJS and still supports Node 20, where `require()` cannot load ESM, so
 * it is loaded with a native dynamic import that TypeScript leaves untouched.
 */
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<typeof import('hyparquet-writer')>;

export type ParquetColumnType = 'STRING' | 'INT32' | 'INT64' | 'DOUBLE' | 'BOOLEAN' | 'TIMESTAMP';

export interface ParquetColumn {
  name: string;
  type: ParquetColumnType;
  /** Same-typed values; `null` marks a missing value (columns are nullable). */
  data: Array<string | number | boolean | bigint | Date | null>;
}

export type ParquetEncoder = (columns: ParquetColumn[], metadata?: Record<string, string>) => Promise<Buffer>;

/** Encodes columns into a Snappy-compressed Parquet file. */
export const encodeParquet: ParquetEncoder = async (columns, metadata = {}) => {
  const { parquetWriteBuffer } = await nativeImport('hyparquet-writer');
  const buffer = parquetWriteBuffer({
    columnData: columns.map((column) => ({ name: column.name, type: column.type, data: column.data as any })),
    codec: 'SNAPPY',
    kvMetadata: Object.entries(metadata).map(([key, value]) => ({ key, value })),
    createdBy: 'stellar-alerts ledger-archival',
  });
  return Buffer.from(buffer);
};
