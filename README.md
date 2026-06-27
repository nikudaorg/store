# nikuda-store

`nikuda-store` is a local, content-addressed store for files, text, and byte
arrays. It keeps immutable revisions, deduplicates unchanged content chunks,
and stores the revision catalog in SQLite.

The package is ESM-only and requires Node.js 18 or newer.

## Install

```sh
npm install nikuda-store
```

## Quick start

```ts
import { createStore } from 'nikuda-store';

const store = createStore({ root: './data' });

const created = await store(async (connection) => {
  return connection.create({
    content: { type: 'text', text: 'First version' },
    originalName: 'note.txt',
    mediaType: 'text/plain',
    metadata: { owner: 'example' }
  });
});

await store(async (connection) => {
  await connection.commit({
    entityId: created.entityId,
    expectedHead: created.revisionId,
    content: { type: 'text', text: 'Second version' }
  });

  const bytes = await connection.readBytes(created.entityId);
  console.log(Buffer.from(bytes).toString('utf8'));
});
```

`createStore` returns a context function. Each callback opens the store,
provides a connection, and closes the underlying database when the callback
finishes, including when it throws.

## Content sources

Create and commit operations accept text, bytes, paths, and Node.js readable
streams:

```ts
await store(async (connection) => {
  await connection.create({
    content: { type: 'path', path: './document.pdf' },
    mediaType: 'application/pdf'
  });

  await connection.create({
    content: { type: 'bytes', bytes: new Uint8Array([1, 2, 3]) }
  });
});
```

The available source shapes are:

```ts
type ContentSource =
  | { type: 'path'; path: string }
  | { type: 'bytes'; bytes: Uint8Array }
  | { type: 'text'; text: string; encoding?: 'utf-8' }
  | { type: 'stream'; stream: NodeJS.ReadableStream };
```

## Reading revisions

`readBytes` reads a revision into memory. Use `openRead` for large content:

```ts
await store(async (connection) => {
  const revision = await connection.getRevision(entityId, 'head');
  const stream = await connection.openRead(entityId, revision.id);

  for await (const chunk of stream) {
    // Process each chunk.
  }
});
```

The optional `readBytesLimit` prevents accidentally loading large revisions
into memory:

```ts
const store = createStore({
  root: './data',
  readBytesLimit: 16 * 1024 * 1024
});
```

The default limit is 64 MiB. It applies to `readBytes`, not `openRead`.

## Optimistic concurrency

Pass `expectedHead` when committing to reject writes based on a stale head:

```ts
await store(async (connection) => {
  await connection.commit({
    entityId,
    expectedHead: currentRevisionId,
    content: { type: 'text', text: 'Updated content' }
  });
});
```

A conflict throws an error whose `code` is `headConflict`.

## Materializing a revision

```ts
await store(async (connection) => {
  await connection.materializeToPath({
    entityId,
    revision: 'head',
    destinationPath: './output/document.pdf'
  });
});
```

Existing files are not overwritten unless `overwrite: true` is supplied.

## Integrity checks

Verify every stored revision, or limit the check to one entity:

```ts
const result = await store((connection) => connection.verify());

if (!result.ok) {
  console.error(result.issues);
}
```

## API

The package exports:

- `createStore(options)`
- `VersionedEntityStore`
- input, result, record, ID, content, and verification types used by the
  public API

## Storage

The configured root contains the SQLite catalog and content-addressed objects.
Keep the entire root together when backing up or moving a store. Do not modify
its files while a store operation is running.

## License

[MIT](./LICENSE)
