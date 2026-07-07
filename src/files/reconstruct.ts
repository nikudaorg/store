import { Readable } from 'node:stream';
import {
  decodeManifest,
  type ContentHash,
  type FileManifestV1
} from '../domain/manifest.js';
import type { ObjectStore } from '../storage/object-store.js';

export const readManifest = (
  objectStore: ObjectStore,
  manifestHash: ContentHash
): FileManifestV1 => decodeManifest(objectStore.read(manifestHash));

export const openFileStream = (
  objectStore: ObjectStore,
  manifest: FileManifestV1
): NodeJS.ReadableStream => {
  async function* generate(): AsyncGenerator<Buffer> {
    let total = 0;
    for (const chunk of manifest.chunks) {
      const bytes = objectStore.read(chunk.hash);
      if (bytes.byteLength !== chunk.length) {
        throw Object.assign(new Error(`Chunk ${chunk.hash} length mismatch`), {
          code: 'contentIntegrity' as const
        });
      }
      total += bytes.byteLength;
      yield bytes;
    }
    if (total !== manifest.byteLength) {
      throw Object.assign(new Error('File byte length mismatch'), {
        code: 'contentIntegrity' as const
      });
    }
  }

  return Readable.from(generate());
};

export const readFileBytes = async (
  objectStore: ObjectStore,
  manifest: FileManifestV1
): Promise<Uint8Array> => {
  const parts: Buffer[] = [];
  for (const chunk of manifest.chunks) {
    const bytes = objectStore.read(chunk.hash);
    if (bytes.byteLength !== chunk.length) {
      throw Object.assign(new Error(`Chunk ${chunk.hash} length mismatch`), {
        code: 'contentIntegrity' as const
      });
    }
    parts.push(bytes);
  }
  const result = Buffer.concat(parts);
  if (result.byteLength !== manifest.byteLength) {
    throw Object.assign(new Error('File byte length mismatch'), {
      code: 'contentIntegrity' as const
    });
  }
  return result;
};
