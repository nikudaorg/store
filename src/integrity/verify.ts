import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { VerifyInput, VerifyIssue, VerifyResult } from '../api/types.js';
import type { ObjectStore } from '../storage/object-store.js';
import type { ReturnTypeCreateRepositories } from './verify-types.js';
import { decodeManifest } from '../domain/manifest.js';

export const verifyStore = async (
  objectStore: ObjectStore,
  repositories: ReturnTypeCreateRepositories,
  input?: VerifyInput
): Promise<VerifyResult> => {
  const issues: VerifyIssue[] = [];
  const manifests = await repositories.allManifestHashes(input?.entityId);

  for (const manifestHash of manifests) {
    const manifestPath = objectStore.objectPath(manifestHash);
    if (!existsSync(manifestPath)) {
      issues.push({
        kind: 'missingObject',
        hash: manifestHash,
        path: join(objectStore.root, objectStore.relativeObjectPath(manifestHash))
      });
      continue;
    }
    const manifestBytes = readFileSync(manifestPath);
    if (createHash('sha256').update(manifestBytes).digest('hex') !== manifestHash) {
      issues.push({ kind: 'corruptObject', hash: manifestHash, path: manifestPath });
      continue;
    }

    const manifest = decodeManifest(manifestBytes);
    let actualLength = 0;
    for (const chunk of manifest.chunks) {
      const path = objectStore.objectPath(chunk.hash);
      if (!existsSync(path)) {
        issues.push({ kind: 'missingObject', hash: chunk.hash, path });
        continue;
      }
      const bytes = readFileSync(path);
      if (createHash('sha256').update(bytes).digest('hex') !== chunk.hash) {
        issues.push({ kind: 'corruptObject', hash: chunk.hash, path });
        continue;
      }
      actualLength += bytes.byteLength;
    }
    if (actualLength !== manifest.byteLength) {
      issues.push({
        kind: 'lengthMismatch',
        revisionId: manifestHash,
        expected: manifest.byteLength,
        actual: actualLength
      });
    }
  }

  return { ok: issues.length === 0, issues };
};
