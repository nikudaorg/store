import { asc, eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type { FileId, FileRecord } from '../api/types.js';
import type { ContentHash } from '../domain/manifest.js';
import type { StoredObject } from '../storage/object-store.js';
import { files, globalMetadata, objects, schema } from './schema.js';

type CatalogOrm = LibSQLDatabase<typeof schema>;
type CatalogTransaction = Parameters<Parameters<CatalogOrm['transaction']>[0]>[0];

interface CreateFileInput {
  readonly id: FileId;
  readonly manifestHash: ContentHash;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly objects: readonly StoredObject[];
}

interface StoreMetadataV1 {
  readonly schema: 'storeMetadataV1';
  readonly rootHistory: readonly {
    readonly fileId: FileId;
    readonly assignedAt: number;
  }[];
}

const storeMetadataKey = 'store';

const parseStoreMetadata = (json: string): StoreMetadataV1 => {
  const value = JSON.parse(json) as unknown;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('schema' in value) ||
    value.schema !== 'storeMetadataV1' ||
    !('rootHistory' in value) ||
    !Array.isArray(value.rootHistory) ||
    !value.rootHistory.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        'fileId' in entry &&
        typeof entry.fileId === 'string' &&
        'assignedAt' in entry &&
        typeof entry.assignedAt === 'number'
    )
  ) {
    throw Object.assign(new Error('Invalid global store metadata'), {
      code: 'storeIntegrity' as const
    });
  }
  return value as StoreMetadataV1;
};

export const createRepositories = (db: CatalogOrm) => {
  const fileFromRow = (row: typeof files.$inferSelect): FileRecord => ({
    id: row.id,
    byteLength: row.byteLength,
    createdAt: row.createdAt
  });

  const getStoredFile = async (fileId: FileId) => {
    const row = await db.query.files.findFirst({
      where: eq(files.id, fileId)
    });
    if (row === undefined) {
      throw Object.assign(new Error(`File ${fileId} was not found`), {
        code: 'fileNotFound' as const
      });
    }
    return row;
  };

  const listFiles = async (): Promise<readonly FileRecord[]> =>
    (
      await db
        .select()
        .from(files)
        .orderBy(asc(files.createdAt), asc(files.id))
    ).map(fileFromRow);

  const createFile = async (input: CreateFileInput): Promise<void> => {
    await db.transaction(async (tx) => {
      await tx
        .insert(objects)
        .values(
          input.objects.map((object) => ({
            hash: object.hash,
            kind: object.kind,
            rawLength: object.rawLength,
            storedLength: object.storedLength,
            codec: object.codec,
            relativePath: object.relativePath,
            createdAt: input.createdAt
          }))
        )
        .onConflictDoNothing({ target: objects.hash });
      await tx.insert(files).values({
        id: input.id,
        manifestHash: input.manifestHash,
        byteLength: input.byteLength,
        createdAt: input.createdAt
      });
    });
  };

  const getStoreMetadata = async (
    target: CatalogOrm | CatalogTransaction = db
  ): Promise<StoreMetadataV1> => {
    const row = await target
      .select({ valueJson: globalMetadata.valueJson })
      .from(globalMetadata)
      .where(eq(globalMetadata.key, storeMetadataKey))
      .get();
    if (row === undefined) {
      throw Object.assign(new Error('Global store metadata was not found'), {
        code: 'storeIntegrity' as const
      });
    }
    return parseStoreMetadata(row.valueJson);
  };

  const getRootFileId = async (): Promise<FileId> => {
    const metadata = await getStoreMetadata();
    const root = metadata.rootHistory.at(-1);
    if (root === undefined) {
      throw Object.assign(new Error('No root file has been assigned'), {
        code: 'rootNotSet' as const
      });
    }
    return root.fileId;
  };

  const setRoot = async (fileId: FileId, assignedAt: number): Promise<void> => {
    await db.transaction(async (tx) => {
      const file = await tx
        .select({ id: files.id })
        .from(files)
        .where(eq(files.id, fileId))
        .get();
      if (file === undefined) {
        throw Object.assign(new Error(`File ${fileId} was not found`), {
          code: 'fileNotFound' as const
        });
      }

      const metadata = await getStoreMetadata(tx);
      const nextMetadata: StoreMetadataV1 = {
        ...metadata,
        rootHistory: [...metadata.rootHistory, { fileId, assignedAt }]
      };
      await tx
        .update(globalMetadata)
        .set({ valueJson: JSON.stringify(nextMetadata) })
        .where(eq(globalMetadata.key, storeMetadataKey));
    });
  };

  return {
    createFile,
    getStoredFile,
    listFiles,
    getRootFileId,
    setRoot
  };
};
