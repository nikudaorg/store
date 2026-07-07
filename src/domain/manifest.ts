import { createHash } from 'node:crypto';
export type ContentHash = string;

export interface FileManifestV1 {
  readonly schema: 'fileManifestV1';
  readonly byteLength: number;
  readonly chunks: readonly {
    readonly hashAlgorithm: 'sha256';
    readonly hash: ContentHash;
    readonly length: number;
  }[];
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
};

export const encodeManifest = (manifest: FileManifestV1): Buffer =>
  Buffer.from(stableStringify(manifest), 'utf8');

export const decodeManifest = (bytes: Uint8Array): FileManifestV1 => {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as FileManifestV1;
  if (parsed.schema !== 'fileManifestV1') {
    throw new Error('Unsupported manifest schema');
  }
  return parsed;
};

export const sha256 = (bytes: Uint8Array): ContentHash =>
  createHash('sha256').update(bytes).digest('hex');
