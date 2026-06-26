import { createHash, randomBytes } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createVersionedEntityStore,
  type VersionedEntityStore
} from '../src/index.js';

let root: string;

const makeRoot = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), 'versioned-entity-store-'));

const bytesOf = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const openDb = (): Client => createClient({ url: `file:${join(root, 'database.sqlite')}` });

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

const objectPathForHash = (hash: string): string =>
  join(root, 'objects', 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash);

const withStore = <Result>(
  useStore: (store: VersionedEntityStore) => Result | Promise<Result>
): Promise<Awaited<Result>> =>
  createVersionedEntityStore({ root, readBytesLimit: 1024 * 1024 }, useStore);

beforeEach(async () => {
  root = await makeRoot();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('versioned entity store', () => {
  it('creates and reads a small text entity', async () => {
    await withStore(async (store) => {
      const created = await store.create({
        content: { type: 'text', text: 'hello versioned world' },
        mediaType: 'text/plain',
        metadata: { purpose: 'test' }
      });

      const entity = await store.getEntity(created.entityId);
      const revision = await store.getRevision(created.entityId, 'head');
      const bytes = await store.readBytes(created.entityId);

      expect(entity.id).toBe(created.entityId);
      expect(revision.id).toBe(created.revisionId);
      expect(Buffer.from(bytes).toString('utf8')).toBe('hello versioned world');
    });
  });

  it('imports and reconstructs a large binary file through streams', async () => {
    const source = join(root, 'source.bin');
    const expected = randomBytes(5 * 1024 * 1024 + 123);
    await writeFile(source, expected);

    await withStore(async (store) => {
      const created = await store.create({ content: { type: 'path', path: source } });
      const entity = await store.getEntity(created.entityId);
      const reconstructed = await bytesOf(await store.openRead(created.entityId));

      expect(entity.originalName).toBe('source.bin');
      expect(reconstructed.equals(expected)).toBe(true);
    });
  });

  it('commits several revisions and recovers each exactly', async () => {
    await withStore(async (store) => {
      const first = Buffer.from('first');
      const second = Buffer.from('second');
      const third = Buffer.from('third');
      const created = await store.create({ content: { type: 'bytes', bytes: first } });
      const committedSecond = await store.commit({
        entityId: created.entityId,
        content: { type: 'bytes', bytes: second }
      });
      const committedThird = await store.commit({
        entityId: created.entityId,
        content: { type: 'bytes', bytes: third }
      });

      await expect(store.readBytes(created.entityId, created.revisionId)).resolves.toEqual(
        first
      );
      await expect(
        store.readBytes(created.entityId, committedSecond.revisionId)
      ).resolves.toEqual(second);
      await expect(
        store.readBytes(created.entityId, committedThird.revisionId)
      ).resolves.toEqual(third);
      await expect(store.listRevisions(created.entityId)).resolves.toHaveLength(3);
    });
  });

  it('reuses unchanged chunks after inserting bytes near the beginning', async () => {
    await withStore(async (store) => {
      const base = randomBytes(4 * 1024 * 1024);
      const changed = Buffer.concat([Buffer.from('inserted'), base]);
      const created = await store.create({ content: { type: 'bytes', bytes: base } });
      const chunksAfterCreate = await chunkCount();

      await store.commit({
        entityId: created.entityId,
        content: { type: 'bytes', bytes: changed }
      });

      expect(chunksAfterCreate).toBeGreaterThan(1);
      await expect(chunkCount()).resolves.toBeLessThan(chunksAfterCreate * 1.5);
      await expect(bytesOf(await store.openRead(created.entityId))).resolves.toEqual(changed);
    });
  });

  it('commits identical content twice without duplicating chunk storage', async () => {
    await withStore(async (store) => {
      const content = randomBytes(800 * 1024);
      const created = await store.create({ content: { type: 'bytes', bytes: content } });
      const chunksAfterCreate = await chunkCount();

      await store.commit({
        entityId: created.entityId,
        content: { type: 'bytes', bytes: content }
      });

      await expect(chunkCount()).resolves.toBe(chunksAfterCreate);
    });
  });

  it('rejects a stale expected head', async () => {
    await withStore(async (store) => {
      const created = await store.create({ content: { type: 'text', text: 'a' } });
      await store.commit({
        entityId: created.entityId,
        expectedHead: created.revisionId,
        content: { type: 'text', text: 'b' }
      });

      await expect(
        store.commit({
          entityId: created.entityId,
          expectedHead: created.revisionId,
          content: { type: 'text', text: 'c' }
        })
      ).rejects.toMatchObject({ code: 'headConflict' });
    });
  });

  it('does not expose staged objects left before a SQLite transaction', async () => {
    const staging = join(root, 'staging');
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'interrupted.tmp'), 'partial');

    await withStore(async (store) => {
      expect(existsSync(join(staging, 'interrupted.tmp'))).toBe(false);
      await expect(store.verify()).resolves.toEqual({ ok: true, issues: [] });
    });
  });

  it('keeps committed revisions visible after reopening the store', async () => {
    const created = await withStore((store) =>
      store.create({ content: { type: 'text', text: 'persisted' } })
    );

    await withStore(async (store) => {
      await expect(store.readBytes(created.entityId)).resolves.toEqual(
        Buffer.from('persisted')
      );
    });
  });

  it('detects corrupted and missing chunks', async () => {
    await withStore(async (store) => {
      const content = Buffer.from('detect corruption');
      const chunkHash = createHash('sha256').update(content).digest('hex');
      const created = await store.create({ content: { type: 'bytes', bytes: content } });

      writeFileSync(objectPathForHash(chunkHash), 'wrong');
      const corrupt = await store.verify({ entityId: created.entityId });
      expect(corrupt.ok).toBe(false);
      expect(corrupt.issues.some((issue) => issue.kind === 'corruptObject')).toBe(true);

      rmSync(objectPathForHash(chunkHash), { force: true });
      const missing = await store.verify({ entityId: created.entityId });
      expect(missing.ok).toBe(false);
      expect(missing.issues.some((issue) => issue.kind === 'missingObject')).toBe(true);
    });
  });

  it('rejects unsafe materialization paths and accidental overwrite', async () => {
    await withStore(async (store) => {
      const created = await store.create({ content: { type: 'text', text: 'file' } });
      const destination = join(root, 'out.txt');
      await writeFile(destination, 'existing');

      await expect(
        store.materializeToPath({
          entityId: created.entityId,
          destinationPath: '../escape.txt'
        })
      ).rejects.toMatchObject({ code: 'unsafePath' });
      await expect(
        store.materializeToPath({ entityId: created.entityId, destinationPath: destination })
      ).rejects.toMatchObject({ code: 'destinationExists' });

      await store.materializeToPath({
        entityId: created.entityId,
        destinationPath: destination,
        overwrite: true
      });
      await expect(readFile(destination, 'utf8')).resolves.toBe('file');
    });
  });

  it('supports stream sources and enforces readBytes size limits', async () => {
    await withStore(async (store) => {
      const content = Buffer.alloc(1024 * 1024 + 1, 7);
      const created = await store.create({
        content: { type: 'stream', stream: Readable.from([content]) }
      });

      await expect(store.readBytes(created.entityId)).rejects.toMatchObject({
        code: 'readLimitExceeded'
      });
      await expect(bytesOf(await store.openRead(created.entityId))).resolves.toEqual(content);
    });
  });

  it('round-trips arbitrary byte arrays', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 128 * 1024 }), async (value) => {
        const localRoot = await makeRoot();
        try {
          await createVersionedEntityStore({ root: localRoot }, async (store) => {
            const created = await store.create({
              content: { type: 'bytes', bytes: value }
            });
            const actual = await store.readBytes(created.entityId);
            expect(Buffer.from(actual).equals(Buffer.from(value))).toBe(true);
          });
        } finally {
          await rm(localRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 25 }
    );
  });

  it('stores all durable objects before making revisions visible', async () => {
    await withStore(async (store) => {
      const before = await objectCount();
      const created = await store.create({ content: { type: 'text', text: 'atomic' } });
      const revision = await store.getRevision(created.entityId);
      const after = await objectCount();
      const manifestExists = existsSync(objectPathForHash(revision.manifestHash));

      expect(after).toBeGreaterThan(before);
      expect(manifestExists).toBe(true);
      await expect(store.verify({ entityId: created.entityId })).resolves.toEqual({
        ok: true,
        issues: []
      });
    });
  });
});
