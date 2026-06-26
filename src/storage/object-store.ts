import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  closeSync,
  fsyncSync
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { ContentHash } from '../api/types.js';

export interface StoredObject {
  readonly hash: ContentHash;
  readonly kind: 'chunk' | 'manifest';
  readonly rawLength: number;
  readonly storedLength: number;
  readonly codec: 'identity';
  readonly relativePath: string;
}

export interface ObjectStore {
  readonly root: string;
  readonly objectPath: (hash: ContentHash) => string;
  readonly relativeObjectPath: (hash: ContentHash) => string;
  readonly has: (hash: ContentHash) => boolean;
  readonly put: (
    bytes: Uint8Array,
    kind: 'chunk' | 'manifest',
    expectedHash?: ContentHash
  ) => StoredObject;
  readonly read: (hash: ContentHash) => Buffer;
  readonly open: (hash: ContentHash) => NodeJS.ReadableStream;
}

export const createObjectStore = (root: string): ObjectStore => {
  const base = join(root, 'objects', 'sha256');
  const staging = join(root, 'staging');

  const relativeObjectPath = (hash: ContentHash): string =>
    join('objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash);

  const objectPath = (hash: ContentHash): string => join(root, relativeObjectPath(hash));

  const has = (hash: ContentHash): boolean => existsSync(objectPath(hash));

  const put = (
    bytes: Uint8Array,
    kind: 'chunk' | 'manifest',
    expectedHash?: ContentHash
  ): StoredObject => {
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (expectedHash !== undefined && expectedHash !== hash) {
      throw Object.assign(new Error(`Object hash mismatch for ${expectedHash}`), {
        code: 'contentIntegrity' as const
      });
    }

    const finalPath = objectPath(hash);
    const relativePath = relative(root, finalPath).split(sep).join('/');
    if (existsSync(finalPath)) {
      return {
        hash,
        kind,
        rawLength: bytes.byteLength,
        storedLength: bytes.byteLength,
        codec: 'identity',
        relativePath
      };
    }

    mkdirSync(dirname(finalPath), { recursive: true });
    mkdirSync(staging, { recursive: true });
    const stagedPath = join(staging, `${randomUUID()}.tmp`);
    writeFileSync(stagedPath, bytes);
    const fd = openSync(stagedPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(stagedPath, finalPath);

    const directoryFd = openSync(dirname(finalPath), 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }

    return {
      hash,
      kind,
      rawLength: bytes.byteLength,
      storedLength: bytes.byteLength,
      codec: 'identity',
      relativePath
    };
  };

  const read = (hash: ContentHash): Buffer => {
    const path = objectPath(hash);
    if (!existsSync(path)) {
      throw Object.assign(new Error(`Missing object ${hash}`), {
        code: 'contentIntegrity' as const
      });
    }
    const bytes = readFileSync(path);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== hash) {
      throw Object.assign(new Error(`Corrupt object ${hash}`), {
        code: 'contentIntegrity' as const
      });
    }
    return bytes;
  };

  return {
    root,
    objectPath,
    relativeObjectPath,
    has,
    put,
    read,
    open: (hash: ContentHash) => createReadStream(objectPath(hash))
  };
};
