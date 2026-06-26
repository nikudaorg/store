# Versioned Entity Store — First Iteration

## Objective

Build a local TypeScript module that stores versioned entities and exposes them through stable random IDs.

An entity is a logical byte sequence with metadata. It may originate from a file, string, buffer, or stream, but its identity must not depend on a filename or storage path.

The first iteration should provide:

- creation of entities from files, bytes, text, or streams;
- stable random entity IDs;
- immutable revisions;
- storage-efficient revision history;
- preservation of the original filename and basic metadata;
- reading and materializing any revision;
- a local SQLite catalogue;
- crash-safe storage operations.

It should not include a UI, HTTP server, cloud synchronization, multi-device replication, editor integration, or automatic file watching.

---

## Core model

Use three distinct identifiers:

```ts
type EntityId = string;
type RevisionId = string;
type ContentHash = string;
```

### Entity

A stable logical object. Its ID remains unchanged as new revisions are created.

### Revision

An immutable version of an entity. Each commit creates a new revision rather than modifying an existing one.

### Content object

An immutable chunk or manifest addressed by a cryptographic hash. Identical content is stored only once and may be reused by multiple revisions or entities.

The relationship is:

```text
entity
  -> revision
      -> manifest
          -> ordered content chunks
```

Entity and revision IDs should be generated from cryptographically secure random bytes and encoded in base32. Content objects should initially use SHA-256 hashes.

---

## Revision storage

Do not use a chain of file diffs as the canonical history.

For every new revision:

1. Stream the input through a content-defined chunker.
2. Hash every chunk.
3. Store only chunks that are not already present.
4. Create an immutable manifest containing the ordered chunk hashes and lengths.
5. Store the manifest and create a revision referencing it.

Content-defined chunking should use FastCDC or a compatible algorithm. Reasonable initial limits are:

```text
minimum chunk size: 256 KiB
target chunk size:  1 MiB
maximum chunk size: 4 MiB
```

This gives efficient reuse when bytes are inserted or removed and keeps memory usage bounded by a small number of chunks.

Text and binary data should use the same canonical storage mechanism. Text-specific diffs may be added later for display or merging, but should not determine how revisions are stored.

Compression is optional for the first usable version. If included, compress chunks independently with Zstandard and keep the original bytes when compression produces little benefit.

---

## Physical storage

Use a storage directory with separate locations for temporary and durable data:

```text
<root>/
  database.sqlite
  objects/
    sha256/
      ab/
        cd/
          <full-hash>
  staging/
```

Durable object paths should be derived from content hashes, not entity IDs.

Object files are immutable. Once an object is placed at its final hash-derived path, it must never be modified.

Small-object packing and inline SQLite storage may be added later. The first iteration can store every chunk and manifest as a separate file for simplicity.

---

## SQLite catalogue

SQLite is an index and local catalogue, not the only representation of revision contents.

At minimum, store:

```sql
CREATE TABLE entities (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    original_name TEXT,
    media_type TEXT,
    metadata_json TEXT,
    deleted_at INTEGER
);

CREATE TABLE revisions (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    source_kind TEXT NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY (entity_id) REFERENCES entities(id)
);

CREATE TABLE revision_parents (
    revision_id TEXT NOT NULL,
    parent_revision_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (revision_id, parent_revision_id)
);

CREATE TABLE entity_heads (
    entity_id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL
);

CREATE TABLE objects (
    hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    raw_length INTEGER NOT NULL,
    stored_length INTEGER NOT NULL,
    codec TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
```

The first iteration only needs one current head per entity, but revision parents should be represented separately so that multiple parents and conflict histories can be supported later without a schema redesign.

Enable foreign keys and WAL mode. All writes should be coordinated through one store instance.

---

## Manifest format

Each revision should have a portable canonical manifest independent of SQLite:

```ts
interface RevisionManifestV1 {
  schema: "versioned-entity-manifest/v1";
  byteLength: number;
  chunks: Array<{
    hashAlgorithm: "sha256";
    hash: ContentHash;
    length: number;
  }>;
}
```

Encode the manifest deterministically, preferably with canonical CBOR. Hash the encoded manifest and store it as an immutable object.

Reconstructing a revision means reading the manifest and concatenating its chunks in order.

---

## Public TypeScript API

Expose a transport-independent object. The implementation may be a class, but callers should depend on an interface.

```ts
interface VersionedEntityStore {
  create(input: CreateEntityInput): Promise<CreateEntityResult>;

  commit(input: CommitRevisionInput): Promise<CommitRevisionResult>;

  getEntity(entityId: EntityId): Promise<EntityRecord>;

  getRevision(
    entityId: EntityId,
    revision?: RevisionId | "head"
  ): Promise<RevisionRecord>;

  listRevisions(entityId: EntityId): Promise<RevisionRecord[]>;

  openRead(
    entityId: EntityId,
    revision?: RevisionId | "head"
  ): Promise<NodeJS.ReadableStream>;

  readBytes(
    entityId: EntityId,
    revision?: RevisionId | "head"
  ): Promise<Uint8Array>;

  materializeToPath(input: MaterializeInput): Promise<void>;

  verify(input?: VerifyInput): Promise<VerifyResult>;

  close(): Promise<void>;
}
```

Suggested inputs:

```ts
type ContentSource =
  | { type: "path"; path: string }
  | { type: "bytes"; bytes: Uint8Array }
  | { type: "text"; text: string; encoding?: "utf-8" }
  | { type: "stream"; stream: NodeJS.ReadableStream };

interface CreateEntityInput {
  content: ContentSource;
  originalName?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

interface CreateEntityResult {
  entityId: EntityId;
  revisionId: RevisionId;
}

interface CommitRevisionInput {
  entityId: EntityId;
  content: ContentSource;
  expectedHead?: RevisionId;
  metadata?: Record<string, unknown>;
  sourceKind?: "api" | "import" | "materialized-file";
}

interface CommitRevisionResult {
  entityId: EntityId;
  revisionId: RevisionId;
  previousHead: RevisionId;
}

interface MaterializeInput {
  entityId: EntityId;
  revision?: RevisionId | "head";
  destinationPath: string;
  overwrite?: boolean;
}
```

`expectedHead` provides optimistic concurrency control. If the entity head changed since the caller last read it, `commit` should fail with a typed conflict error rather than silently overwriting the newer head.

`readBytes` is a convenience method and should reject revisions above a configurable size limit. Large content should be consumed through `openRead`.

---

## Import behavior

When creating an entity from a path:

- preserve the source basename as `originalName` unless explicitly overridden;
- do not rename, move, or delete the source file;
- stream the contents instead of reading the entire file into memory;
- return the new entity ID and initial revision ID.

Filenames are metadata only. They must not affect entity identity, deduplication, or internal object paths.

---

## Commit and crash-safety rules

A commit must not become visible in SQLite before its objects are durable.

Use this order:

1. Stream and chunk the input.
2. Write missing objects into `staging`.
3. Flush completed object files.
4. Atomically rename them to final hash-derived paths.
5. Create and durably store the manifest.
6. Start a SQLite transaction.
7. Insert object metadata, revision rows, and parent relationships.
8. Update the entity head.
9. Commit the transaction.

A crash may leave unreferenced objects, but must not leave a committed revision with missing content.

Temporary files should use unique names and be cleaned on startup. Do not delete unknown durable objects immediately; later garbage collection can remove objects that are not reachable from retained revisions.

---

## Required invariants

The implementation should enforce these rules:

- Entity IDs and revision IDs are globally unique random values.
- Revisions are immutable.
- Content objects are immutable and verified against their hashes.
- The current head always references an existing revision of the same entity.
- A revision is visible only after all required objects are durable.
- Reading a revision always produces exactly its recorded byte length.
- Committing identical content may create a new revision, but must not duplicate chunk storage.
- Original filenames are never treated as trusted paths.
- All public errors use typed error classes or discriminated error codes.

---

## Module structure

A practical package layout is:

```text
src/
  index.ts
  api/
    types.ts
    errors.ts
  domain/
    ids.ts
    manifest.ts
  catalog/
    database.ts
    migrations.ts
    repositories.ts
  storage/
    object-store.ts
    staging.ts
  revisions/
    chunker.ts
    ingest.ts
    reconstruct.ts
    commit.ts
  integrity/
    verify.ts
```

Keep storage, catalogue, and domain logic behind interfaces. This makes it possible to add packfiles, encryption, S3, Google Drive, or another metadata database later without changing the public entity API.

---

## Tests required before calling the iteration complete

At minimum:

- create and read a small text entity;
- import and reconstruct a large binary file using bounded memory;
- commit several revisions and recover each exactly;
- verify that unchanged chunks are reused;
- insert bytes near the beginning of a file and confirm substantial chunk reuse;
- commit identical content twice without duplicating objects;
- reject a commit with a stale `expectedHead`;
- recover safely from interruption before and after the SQLite transaction;
- detect corrupted or missing chunks;
- reject unsafe materialization paths and accidental overwrite;
- reopen the store and read all previously committed entities.

Use byte-for-byte comparisons and property-based tests for chunking and reconstruction.

---

## Explicitly deferred

The first iteration should not implement:

- Electron or any user interface;
- HTTP or network APIs;
- automatic watching of materialized files;
- checkout leases and cleanup;
- cloud providers;
- synchronization between devices;
- conflict merging;
- retention policies and garbage collection;
- packfiles or small-object compaction;
- encryption;
- previews, thumbnails, or text diff presentation.

The design must leave room for these features, but they should not complicate the first implementation.

---

## Completion criterion

The iteration is complete when a caller can initialize the module, create an entity from any supported content source, receive a stable entity ID, commit additional revisions, list and read old revisions, and materialize any revision as an ordinary file, with deduplicated immutable storage and recovery-safe metadata updates.
