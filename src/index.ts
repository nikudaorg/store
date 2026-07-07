import { resolve } from 'node:path';
import type {
  Connection,
  ContentSource,
  CreateFileStoreOptions,
  FileId,
  FileRecord
} from './api/types.js';
import { openDatabase } from './catalog/database.js';
import { createRepositories } from './catalog/repositories.js';
import { createRandomId } from './domain/ids.js';
import { ingestContent } from './files/ingest.js';
import {
  openFileStream,
  readFileBytes,
  readManifest
} from './files/reconstruct.js';
import { createObjectStore } from './storage/object-store.js';

export type {
  Connection as FileStore,
  ContentSource,
  CreateFileStoreOptions,
  FileId,
  FileRecord
} from './api/types.js';

const defaultReadBytesLimit = 64 * 1024 * 1024;

const assertOpen = (closed: boolean): void => {
  if (closed) {
    throw Object.assign(new Error('The store is closed'), {
      code: 'closed' as const
    });
  }
};

export const createStore =
  (options: CreateFileStoreOptions) =>
  async <Result>(
    callback: (connection: Connection) => Result | Promise<Result>
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

    const create = async (content: ContentSource): Promise<FileId> => {
      await ensureReady();
      const prepared = await ingestContent(objectStore, content);
      const fileId = createRandomId();
      const createdAt = Date.now();

      await repositories.createFile({
        id: fileId,
        manifestHash: prepared.manifestObject.hash,
        byteLength: prepared.manifest.byteLength,
        createdAt,
        objects: [...prepared.chunkObjects, prepared.manifestObject]
      });

      return fileId;
    };

    const read = async (fileId: FileId): Promise<NodeJS.ReadableStream> => {
      await ensureReady();
      const file = await repositories.getStoredFile(fileId);
      return openFileStream(
        objectStore,
        readManifest(objectStore, file.manifestHash)
      );
    };

    const readBytes = async (fileId: FileId): Promise<Uint8Array> => {
      await ensureReady();
      const file = await repositories.getStoredFile(fileId);
      if (file.byteLength > readBytesLimit) {
        throw Object.assign(
          new Error(`File ${file.id} is larger than readBytesLimit`),
          { code: 'readLimitExceeded' as const }
        );
      }
      return readFileBytes(
        objectStore,
        readManifest(objectStore, file.manifestHash)
      );
    };

    const listFiles = async (): Promise<readonly FileRecord[]> => {
      await ensureReady();
      return repositories.listFiles();
    };

    const setRoot = async (fileId: FileId): Promise<void> => {
      await ensureReady();
      await repositories.setRoot(fileId, Date.now());
    };

    const readRoot = async (): Promise<NodeJS.ReadableStream> => {
      await ensureReady();
      return read(await repositories.getRootFileId());
    };

    const readBytesRoot = async (): Promise<Uint8Array> => {
      await ensureReady();
      return readBytes(await repositories.getRootFileId());
    };

    const connection: Connection = {
      create,
      read,
      readBytes,
      listFiles,
      setRoot,
      readRoot,
      readBytesRoot
    };

    try {
      await catalog.ready;
      return await callback(connection);
    } finally {
      if (!closed) {
        await catalog.ready;
        catalog.client.close();
        closed = true;
      }
    }
  };
