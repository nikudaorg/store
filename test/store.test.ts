import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createClient, type Client } from '@libsql/client';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../src/index.js';

let root: string;

const makeRoot = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'nikuda-store-'));

const bytesOf = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const openDb = (): Client =>
  createClient({ url: `file:${join(root, 'database.sqlite')}` });

const objectCount = async (): Promise<number> => {
  const db = openDb();
  try {
    const result = await db.execute('SELECT count(*) AS count FROM objects');
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    db.close();
  }
};

const chunkCount = async (): Promise<number> => {
  const db = openDb();
  try {
    const result = await db.execute(
      "SELECT count(*) AS count FROM objects WHERE kind = 'chunk'"
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    db.close();
  }
};

const rootHistory = async (): Promise<
  readonly { readonly fileId: string; readonly assignedAt: number }[]
> => {
  const db = openDb();
  try {
    const result = await db.execute({
      sql: "SELECT value_json FROM global_metadata WHERE key = 'store'",
      args: []
    });
    const json = String(result.rows[0]?.value_json);
    const metadata = JSON.parse(json) as {
      readonly rootHistory: readonly {
        readonly fileId: string;
        readonly assignedAt: number;
      }[];
    };
    return metadata.rootHistory;
  } finally {
    db.close();
  }
};

const objectPathForHash = (hash: string): string =>
  join(root, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash);

const store: ReturnType<typeof createStore> = (cb) =>
  createStore({ root, readBytesLimit: 1024 })(cb);

beforeEach(async () => {
  root = await makeRoot();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('file store', () => {
  it('creates and reads a small text file', async () => {
    await store(async (connection) => {
      const fileId = await connection.create({
        type: 'text',
        text: 'hello immutable file'
      });

      const bytes = await connection.readBytes(fileId);
      const streamBytes = await bytesOf(await connection.read(fileId));

      expect(fileId).toMatch(/^file_/);
      expect(Buffer.from(bytes).toString('utf8')).toBe('hello immutable file');
      expect(streamBytes.toString('utf8')).toBe('hello immutable file');
    });
  });

  it('imports and reconstructs a large binary file through streams', async () => {
    const source = join(root, 'source.bin');
    const expected = randomBytes(5 * 1024 * 1024 + 123);
    await writeFile(source, expected);

    await store(async (connection) => {
      const fileId = await connection.create({ type: 'path', path: source });
      const reconstructed = await bytesOf(await connection.read(fileId));

      expect(reconstructed.equals(expected)).toBe(true);
    });
  });

  it('lists stored immutable files in creation order', async () => {
    await store(async (connection) => {
      const first = await connection.create({ type: 'text', text: 'first' });
      const second = await connection.create({ type: 'text', text: 'second' });

      await expect(connection.listFiles()).resolves.toEqual([
        expect.objectContaining({ id: first, byteLength: 5 }),
        expect.objectContaining({ id: second, byteLength: 6 })
      ]);
    });
  });

  it('assigns root and records root history in global metadata', async () => {
    await store(async (connection) => {
      const first = await connection.create({ type: 'text', text: 'first' });
      const second = await connection.create({ type: 'text', text: 'second' });

      await connection.setRoot(first);
      await expect(connection.readBytesRoot()).resolves.toEqual(
        Buffer.from('first')
      );

      await connection.setRoot(second);
      await expect(bytesOf(await connection.readRoot())).resolves.toEqual(
        Buffer.from('second')
      );

      const history = await rootHistory();
      expect(history.map((entry) => entry.fileId)).toEqual([first, second]);
      expect(history.every((entry) => Number.isInteger(entry.assignedAt))).toBe(
        true
      );
    });
  });

  it('rejects reading root before one is assigned', async () => {
    await store(async (connection) => {
      await expect(connection.readBytesRoot()).rejects.toMatchObject({
        code: 'rootNotSet'
      });
    });
  });

  it('rejects assigning a missing file as root', async () => {
    await store(async (connection) => {
      await expect(connection.setRoot('file_missing')).rejects.toMatchObject({
        code: 'fileNotFound'
      });
    });
  });

  it(
    'shares unchanged chunks between independently created files',
    async () => {
      await store(async (connection) => {
        const base = randomBytes(4 * 1024 * 1024);
        const changed = Buffer.concat([Buffer.from('inserted'), base]);
        const baseId = await connection.create({ type: 'bytes', bytes: base });
        const chunksAfterBase = await chunkCount();

        const changedId = await connection.create({
          type: 'bytes',
          bytes: changed
        });

        expect(chunksAfterBase).toBeGreaterThan(1);
        await expect(chunkCount()).resolves.toBeLessThan(chunksAfterBase * 1.5);
        await expect(bytesOf(await connection.read(baseId))).resolves.toEqual(
          base
        );
        await expect(bytesOf(await connection.read(changedId))).resolves.toEqual(
          changed
        );
      });
    },
    15_000
  );

  it('does not duplicate chunk storage for identical files', async () => {
    await store(async (connection) => {
      const content = randomBytes(800 * 1024);
      await connection.create({ type: 'bytes', bytes: content });
      const chunksAfterFirst = await chunkCount();

      await connection.create({ type: 'bytes', bytes: content });

      await expect(chunkCount()).resolves.toBe(chunksAfterFirst);
    });
  });

  it('removes leftover staging files when opening the store', async () => {
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'interrupted.tmp'), 'partial');

    await store(async (connection) => {
      expect(existsSync(join(staging, 'interrupted.tmp'))).toBe(false);
      await expect(connection.listFiles()).resolves.toEqual([]);
    });
  });

  it('keeps files and root assignment visible after reopening the store', async () => {
    const fileId = await store(async (connection) => {
      const created = await connection.create({
        type: 'text',
        text: 'persisted'
      });
      await connection.setRoot(created);
      return created;
    });

    await store(async (connection) => {
      await expect(connection.readBytes(fileId)).resolves.toEqual(
        Buffer.from('persisted')
      );
      await expect(connection.readBytesRoot()).resolves.toEqual(
        Buffer.from('persisted')
      );
    });
  });

  it('supports stream sources and enforces readBytes size limits', async () => {
    await store(async (connection) => {
      const content = Buffer.alloc(1024 * 1024 + 1, 7);
      const fileId = await connection.create({
        type: 'stream',
        stream: Readable.from([content])
      });

      await expect(connection.readBytes(fileId)).rejects.toMatchObject({
        code: 'readLimitExceeded'
      });
      await expect(bytesOf(await connection.read(fileId))).resolves.toEqual(
        content
      );
    });
  });

  it('round-trips arbitrary byte arrays', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 128 * 1024 }), async (value) => {
        const localRoot = await makeRoot();
        try {
          await createStore({ root: localRoot })(async (connection) => {
            const fileId = await connection.create({
              type: 'bytes',
              bytes: value
            });
            const actual = await connection.readBytes(fileId);
            expect(Buffer.from(actual).equals(Buffer.from(value))).toBe(true);
          });
        } finally {
          await rm(localRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 25 }
    );
  });

  it('stores durable objects before making files visible', async () => {
    await store(async (connection) => {
      const before = await objectCount();
      const fileId = await connection.create({ type: 'text', text: 'atomic' });
      const after = await objectCount();
      const db = createClient({ url: `file:${join(root, 'database.sqlite')}` });
      let manifestHash = '';
      try {
        const hash = await db.execute({
          sql: 'SELECT manifest_hash FROM files WHERE id = ?',
          args: [fileId]
        });
        manifestHash = String(hash.rows[0]?.manifest_hash);
      } finally {
        db.close();
      }

      expect(after).toBeGreaterThan(before);
      expect(objectPathForHash(manifestHash)).toSatisfy(existsSync);
    });
  });
});
