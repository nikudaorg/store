import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ContentSource } from '../api/types.js';
import type { ObjectStore, StoredObject } from '../storage/object-store.js';
import { chunkReadable } from './chunker.js';
import {
  encodeManifest,
  type FileManifestV1
} from '../domain/manifest.js';

export interface PreparedFile {
  readonly manifest: FileManifestV1;
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

export const ingestContent = async (
  objectStore: ObjectStore,
  content: ContentSource
): Promise<PreparedFile> => {
  const chunks = await chunkReadable(sourceStream(content));
  const chunkObjects = chunks.map((chunk) =>
    objectStore.put(chunk.bytes, 'chunk', chunk.hash)
  );
  const byteLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const manifest: FileManifestV1 = {
    schema: 'fileManifestV1',
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
