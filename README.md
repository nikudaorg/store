# nikuda-store

`nikuda-store` is a local, content-addressed store for immutable files, text,
and byte arrays. It deduplicates content chunks and keeps a small SQLite
catalog.

The package is ESM-only and requires Node.js 18 or newer.

## Install

```sh
npm install nikuda-store
```

## Quick start

```ts
import { createStore } from 'nikuda-store';

const store = createStore({ root: './data' });

const fileId = await store((connection) =>
  connection.create({ type: 'text', text: 'Hello store!' })
);

await store(async (connection) => {
  await connection.setRoot(fileId);

  const bytes = await connection.readBytesRoot();
  console.log(Buffer.from(bytes).toString('utf8'));
});
```

`createStore` returns a context function. Each callback opens the store,
provides a connection, and closes the underlying database when the callback
finishes, including when it throws.

## Content sources

`create` accepts text, bytes, paths, and Node.js readable streams:

```ts
await store(async (connection) => {
  await connection.create({ type: 'path', path: './document.pdf' });

  await connection.create({
    type: 'bytes',
    bytes: new Uint8Array([1, 2, 3])
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

## Reading files

`readBytes` reads a file into memory. Use `read` for large content:

```ts
await store(async (connection) => {
  const stream = await connection.read(fileId);

  for await (const chunk of stream) {
    // Process each chunk.
  }
});
```

The optional `readBytesLimit` prevents accidentally loading large files into
memory:

```ts
const store = createStore({
  root: './data',
  readBytesLimit: 16 * 1024 * 1024
});
```

The default limit is 64 MiB. It applies to `readBytes` and `readBytesRoot`, not
to `read` or `readRoot`.

## Root file

One stored file can be assigned as the global root:

```ts
await store(async (connection) => {
  const fileId = await connection.create({ type: 'text', text: 'root' });
  await connection.setRoot(fileId);

  const rootBytes = await connection.readBytesRoot();
});
```

Every root assignment is appended to the store's global metadata. The public API
only exposes the current root for reading.

## API

The package exports:

- `createStore(options)`
- `FileStore`
- `ContentSource`
- `CreateFileStoreOptions`
- `FileId`
- `FileRecord`

The connection API is intentionally small:

```ts
interface FileStore {
  create(content: ContentSource): Promise<FileId>;
  read(fileId: FileId): Promise<NodeJS.ReadableStream>;
  readBytes(fileId: FileId): Promise<Uint8Array>;
  listFiles(): Promise<readonly FileRecord[]>;
  setRoot(fileId: FileId): Promise<void>;
  readRoot(): Promise<NodeJS.ReadableStream>;
  readBytesRoot(): Promise<Uint8Array>;
}
```

## Storage

The configured root contains the SQLite catalog and content-addressed objects.
Keep the entire root together when backing up or moving a store. Do not modify
its files while a store operation is running.

## License

[MIT](./LICENSE)
