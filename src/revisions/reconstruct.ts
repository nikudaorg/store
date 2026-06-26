import { Readable } from 'node:stream';
import type { ContentHash } from '../api/types.js';
import { decodeManifest, type RevisionManifestV1 } from '../domain/manifest.js';
import type { ObjectStore } from '../storage/object-store.js';

export const readManifest = (
  objectStore: ObjectStore,
  manifestHash: ContentHash
): RevisionManifestV1 => decodeManifest(objectStore.read(manifestHash));

export const openRevisionStream = (
  objectStore: ObjectStore,
  manifest: RevisionManifestV1
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
      throw Object.assign(new Error('Revision byte length mismatch'), {
        code: 'contentIntegrity' as const
      });
    }
  }

  return Readable.from(generate());
};

export const readRevisionBytes = async (
  objectStore: ObjectStore,
  manifest: RevisionManifestV1
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
    throw Object.assign(new Error('Revision byte length mismatch'), {
      code: 'contentIntegrity' as const
    });
  }
  return result;
};
