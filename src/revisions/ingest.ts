import { basename } from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ContentSource } from '../api/types.js';
import type { ObjectStore, StoredObject } from '../storage/object-store.js';
import { chunkReadable } from './chunker.js';
import {
  encodeManifest,
  type RevisionManifestV1
} from '../domain/manifest.js';

export interface PreparedRevision {
  readonly manifest: RevisionManifestV1;
  readonly manifestObject: StoredObject;
  readonly chunkObjects: readonly StoredObject[];
}

export const sourceStream = (content: ContentSource): NodeJS.ReadableStream => {
  if (content.type === 'path') {
    return createReadStream(content.path);
  }
  if (content.type === 'bytes') {
    return ReadableFrom([Buffer.from(content.bytes)]);
  }
  if (content.type === 'text') {
    return ReadableFrom([Buffer.from(content.text, content.encoding ?? 'utf-8')]);
  }
  return content.stream;
};

const ReadableFrom = (parts: readonly Buffer[]): NodeJS.ReadableStream => {
  return Readable.from(parts);
};

export const inferOriginalName = (content: ContentSource): string | undefined =>
  content.type === 'path' ? basename(content.path) : undefined;

export const inferSourceKind = (content: ContentSource): 'api' | 'import' =>
  content.type === 'path' ? 'import' : 'api';

export const ingestContent = async (
  objectStore: ObjectStore,
  content: ContentSource
): Promise<PreparedRevision> => {
  const chunks = await chunkReadable(sourceStream(content));
  const chunkObjects = chunks.map((chunk) =>
    objectStore.put(chunk.bytes, 'chunk', chunk.hash)
  );
  const byteLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const manifest: RevisionManifestV1 = {
    schema: 'versionedEntityManifestV1',
    byteLength,
    chunks: chunks.map((chunk) => ({
      hashAlgorithm: 'sha256',
      hash: chunk.hash,
      length: chunk.length
    }))
  };
  const manifestObject = objectStore.put(encodeManifest(manifest), 'manifest');

  return {
    manifest,
    manifestObject,
    chunkObjects
  };
};
