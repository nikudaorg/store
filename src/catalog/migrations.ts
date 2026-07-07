import type { Client } from '@libsql/client';

const initialStoreMetadata =
  '{"schema":"storeMetadataV1","rootHistory":[]}';

export const migrate = async (client: Client): Promise<void> => {
  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA synchronous = FULL');

  await client.batch([
    `CREATE TABLE IF NOT EXISTS objects (
      hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      raw_length INTEGER NOT NULL,
      stored_length INTEGER NOT NULL,
      codec TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      manifest_hash TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (manifest_hash) REFERENCES objects(hash)
    )`,

    `CREATE TABLE IF NOT EXISTS global_metadata (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    )`,

    `INSERT OR IGNORE INTO global_metadata (key, value_json)
      VALUES ('store', '${initialStoreMetadata}')`
  ]);
};
