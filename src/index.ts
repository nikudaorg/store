import {
  constants,
  createWriteStream,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync
} from 'node:fs';
import { access, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type {
  CommitRevisionInput,
  CommitRevisionResult,
  CreateEntityInput,
  CreateEntityResult,
  CreateVersionedEntityStoreOptions,
  EntityId,
  EntityRecord,
  MaterializeInput,
  RevisionId,
  RevisionRecord,
  Connection
} from './api/types.js';
import { openDatabase } from './catalog/database.js';
import { createRepositories } from './catalog/repositories.js';
import { createRandomId } from './domain/ids.js';
import { createObjectStore } from './storage/object-store.js';
import {
  inferOriginalName,
  inferSourceKind,
  ingestContent
} from './revisions/ingest.js';
import {
  openRevisionStream,
  readManifest,
  readRevisionBytes
} from './revisions/reconstruct.js';
import { verifyStore } from './integrity/verify.js';

export type {
  CommitRevisionInput,
  CommitRevisionResult,
  ContentHash,
  ContentSource,
  CreateEntityInput,
  CreateEntityResult,
  CreateVersionedEntityStoreOptions,
  EntityId,
  EntityRecord,
  MaterializeInput,
  RevisionId,
  RevisionRecord,
  VerifyInput,
  VerifyIssue,
  VerifyResult,
  Connection as VersionedEntityStore
} from './api/types.js';

const defaultReadBytesLimit = 64 * 1024 * 1024;

const stringifyMetadata = (metadata?: Record<string, unknown>): string =>
  JSON.stringify(metadata ?? {});

const assertOpen = (closed: boolean): void => {
  if (closed) {
    throw Object.assign(new Error('The store is closed'), {
      code: 'closed' as const
    });
  }
};

const isUnsafeRelativePath = (path: string): boolean => {
  const normalized = normalize(path);
  return (
    normalized === '' ||
    normalized === '.' ||
    normalized.split(sep).includes('..') ||
    (!isAbsolute(path) && path.startsWith('~'))
  );
};

const assertCanMaterialize = async (
  destinationPath: string,
  overwrite: boolean
): Promise<void> => {
  if (isUnsafeRelativePath(destinationPath)) {
    throw Object.assign(
      new Error(`Unsafe materialization path: ${destinationPath}`),
      {
        code: 'unsafePath' as const
      }
    );
  }
  if (!overwrite) {
    try {
      await access(destinationPath, constants.F_OK);
      throw Object.assign(new Error(`${destinationPath} already exists`), {
        code: 'destinationExists' as const
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
};

const fsyncDirectory = (path: string): void => {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export const createStore =
  (options: CreateVersionedEntityStoreOptions) =>
  async <Result>(
    callback: (conn: Connection) => Result | Promise<Result>
  ): Promise<Awaited<Result>> => {
    const root = resolve(options.root);
    const catalog = openDatabase(root);
    const objectStore = createObjectStore(root);
    const repositories = createRepositories(catalog.db);
    const readBytesLimit = options.readBytesLimit ?? defaultReadBytesLimit;
    let closed = false;

    const ensureReady = async (): Promise<void> => {
      assertOpen(closed);
      await catalog.ready;
      assertOpen(closed);
    };

    const create = async (
      input: CreateEntityInput
    ): Promise<CreateEntityResult> => {
      await ensureReady();
      const prepared = await ingestContent(objectStore, input.content);
      const now = Date.now();
      const entityId = createRandomId('ent');
      const revisionId = createRandomId('rev');
      const originalName =
        input.originalName ?? inferOriginalName(input.content);
      const sourceKind = inferSourceKind(input.content);

      await repositories.createEntityRevision({
        entityId,
        revisionId,
        manifestHash: prepared.manifestObject.hash,
        byteLength: prepared.manifest.byteLength,
        createdAt: now,
        originalName,
        mediaType: input.mediaType,
        entityMetadataJson: stringifyMetadata(input.metadata),
        revisionMetadataJson: stringifyMetadata(input.metadata),
        sourceKind,
        objects: [...prepared.chunkObjects, prepared.manifestObject]
      });

      return { entityId, revisionId };
    };

    const commit = async (
      input: CommitRevisionInput
    ): Promise<CommitRevisionResult> => {
      await ensureReady();
      await repositories.getEntity(input.entityId);
      const previousHead = await repositories.getHeadRevisionId(input.entityId);
      if (
        input.expectedHead !== undefined &&
        input.expectedHead !== previousHead
      ) {
        throw Object.assign(
          new Error(
            `Expected head ${input.expectedHead}, found ${previousHead}`
          ),
          { code: 'headConflict' as const }
        );
      }

      const prepared = await ingestContent(objectStore, input.content);
      const now = Date.now();
      const revisionId = createRandomId('rev');

      await repositories.commitEntityRevision({
        revisionId,
        entityId: input.entityId,
        previousHead,
        manifestHash: prepared.manifestObject.hash,
        byteLength: prepared.manifest.byteLength,
        createdAt: now,
        sourceKind: input.sourceKind ?? inferSourceKind(input.content),
        metadataJson: stringifyMetadata(input.metadata),
        objects: [...prepared.chunkObjects, prepared.manifestObject]
      });

      return { revisionId, previousHead };
    };

    const getEntity = async (entityId: EntityId): Promise<EntityRecord> => {
      await ensureReady();
      return repositories.getEntity(entityId);
    };

    const getRevision = async (
      entityId: EntityId,
      revision?: RevisionId | 'head'
    ): Promise<RevisionRecord> => {
      await ensureReady();
      return repositories.getRevision(entityId, revision);
    };

    const listRevisions = async (
      entityId: EntityId
    ): Promise<RevisionRecord[]> => {
      await ensureReady();
      return repositories.listRevisions(entityId);
    };

    const openRead = async (
      entityId: EntityId,
      revision?: RevisionId | 'head'
    ): Promise<NodeJS.ReadableStream> => {
      await ensureReady();
      const record = await repositories.getRevision(entityId, revision);
      const manifest = readManifest(objectStore, record.manifestHash);
      return openRevisionStream(objectStore, manifest);
    };

    const readBytes = async (
      entityId: EntityId,
      revision?: RevisionId | 'head'
    ): Promise<Uint8Array> => {
      await ensureReady();
      const record = await repositories.getRevision(entityId, revision);
      if (record.byteLength > readBytesLimit) {
        throw Object.assign(
          new Error(`Revision ${record.id} is larger than readBytesLimit`),
          { code: 'readLimitExceeded' as const }
        );
      }
      const manifest = readManifest(objectStore, record.manifestHash);
      return readRevisionBytes(objectStore, manifest);
    };

    const materializeToPath = async (
      input: MaterializeInput
    ): Promise<void> => {
      await ensureReady();
      await assertCanMaterialize(
        input.destinationPath,
        input.overwrite ?? false
      );
      mkdirSync(dirname(input.destinationPath), { recursive: true });
      const destination = resolve(input.destinationPath);
      const temporaryPath = `${destination}.tmp-${process.pid}-${Date.now()}`;
      const stream = await openRead(input.entityId, input.revision);
      try {
        await pipeline(
          stream,
          createWriteStream(temporaryPath, { flags: 'wx' })
        );
        const fd = openSync(temporaryPath, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        await rename(temporaryPath, destination);
        fsyncDirectory(dirname(destination));
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
    };

    const verify = async (input?: Parameters<Connection['verify']>[0]) => {
      await ensureReady();
      return verifyStore(objectStore, repositories, input);
    };

    const closeStore = async (): Promise<void> => {
      if (!closed) {
        await catalog.ready;
        catalog.client.close();
        closed = true;
      }
    };

    const store: Connection = {
      create,
      commit,
      getEntity,
      getRevision,
      listRevisions,
      openRead,
      readBytes,
      materializeToPath,
      verify
    };

    try {
      await catalog.ready;
      return await callback(store);
    } finally {
      await closeStore();
    }
  };