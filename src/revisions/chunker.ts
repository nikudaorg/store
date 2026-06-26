import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export interface Chunk {
  readonly bytes: Buffer;
  readonly hash: string;
  readonly length: number;
}

export interface ChunkerOptions {
  readonly minimumSize: number;
  readonly targetSize: number;
  readonly maximumSize: number;
}

export const defaultChunkerOptions: ChunkerOptions = {
  minimumSize: 256 * 1024,
  targetSize: 1024 * 1024,
  maximumSize: 4 * 1024 * 1024
};

const boundaryMask = (targetSize: number): number => {
  const bits = Math.max(10, Math.round(Math.log2(targetSize)));
  return (1 << Math.min(bits, 30)) - 1;
};

const gearTable = Array.from({ length: 256 }, (_, index) => {
  let value = (index + 1) * 0x9e3779b1;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
});

const windowSize = 64;

export const chunkReadable = async (
  stream: NodeJS.ReadableStream,
  options: ChunkerOptions = defaultChunkerOptions
): Promise<readonly Chunk[]> => {
  const chunks: Chunk[] = [];
  const current: Buffer[] = [];
  const mask = boundaryMask(options.targetSize);
  const window = new Uint8Array(windowSize);
  let windowPosition = 0;
  let windowLength = 0;
  let currentLength = 0;
  let rollingHash = 0;

  const emit = (): void => {
    const bytes = Buffer.concat(current, currentLength);
    chunks.push({
      bytes,
      hash: createHash('sha256').update(bytes).digest('hex'),
      length: bytes.byteLength
    });
    current.length = 0;
    currentLength = 0;
  };

  for await (const part of stream as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      const nextByte = bytes[index];
      const previousByte = window[windowPosition];
      window[windowPosition] = nextByte;
      windowPosition = (windowPosition + 1) % windowSize;
      windowLength = Math.min(windowLength + 1, windowSize);
      rollingHash =
        ((rollingHash << 1) ^
          gearTable[nextByte] ^
          (windowLength === windowSize ? gearTable[previousByte] : 0)) >>>
        0;
      currentLength += 1;
      const boundary =
        currentLength >= options.maximumSize ||
        (currentLength >= options.minimumSize && (rollingHash & mask) === 0);
      if (boundary) {
        current.push(bytes.subarray(start, index + 1));
        emit();
        start = index + 1;
      }
    }
    if (start < bytes.length) {
      current.push(bytes.subarray(start));
    }
  }

  if (currentLength > 0 || chunks.length === 0) {
    emit();
  }

  return chunks;
};

export const streamFromBytes = (bytes: Uint8Array): NodeJS.ReadableStream =>
  Readable.from([Buffer.from(bytes)]);
