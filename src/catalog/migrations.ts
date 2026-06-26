import type { Client } from '@libsql/client';

export const migrate = async (client: Client): Promise<void> => {
  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute('PRAGMA journal_mode = WAL');
  await client.execute('PRAGMA synchronous = FULL');

  await client.batch([
    `CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      original_name TEXT,
      media_type TEXT,
      metadata_json TEXT NOT NULL,
      deleted_at INTEGER
    )`,

    `CREATE TABLE IF NOT EXISTS objects (
      hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      raw_length INTEGER NOT NULL,
      stored_length INTEGER NOT NULL,
      codec TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      source_kind TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      FOREIGN KEY (entity_id) REFERENCES entities(id),
      FOREIGN KEY (manifest_hash) REFERENCES objects(hash)
    )`,

    `CREATE TABLE IF NOT EXISTS revision_parents (
      revision_id TEXT NOT NULL,
      parent_revision_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (revision_id, parent_revision_id),
      FOREIGN KEY (revision_id) REFERENCES revisions(id),
      FOREIGN KEY (parent_revision_id) REFERENCES revisions(id)
    )`,

    `CREATE TABLE IF NOT EXISTS entity_heads (
      entity_id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL,
      FOREIGN KEY (entity_id) REFERENCES entities(id),
      FOREIGN KEY (revision_id) REFERENCES revisions(id)
    )`
  ]);
};
