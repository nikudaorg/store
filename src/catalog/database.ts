import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from './migrations.js';
import { schema } from './schema.js';

export interface CatalogDatabase {
  readonly client: Client;
  readonly db: LibSQLDatabase<typeof schema>;
  readonly ready: Promise<void>;
}

export const openDatabase = (root: string): CatalogDatabase => {
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'objects', 'sha256'), { recursive: true });
  rmSync(join(root, 'staging'), { force: true, recursive: true });
  mkdirSync(join(root, 'staging'), { recursive: true });

  const client = createClient({ url: `file:${join(root, 'database.sqlite')}` });
  const db = drizzle(client, { schema });
  return {
    client,
    db,
    ready: migrate(client)
  };
};
