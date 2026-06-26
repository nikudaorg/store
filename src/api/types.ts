export type EntityId = string;
export type RevisionId = string;
export type ContentHash = string;

export type ContentSource =
  | { readonly type: 'path'; readonly path: string }
  | { readonly type: 'bytes'; readonly bytes: Uint8Array }
  | { readonly type: 'text'; readonly text: string; readonly encoding?: 'utf-8' }
  | { readonly type: 'stream'; readonly stream: NodeJS.ReadableStream };

export type SourceKind = 'api' | 'import' | 'materializedFile';

export interface CreateEntityInput {
  readonly content: ContentSource;
  readonly originalName?: string;
  readonly mediaType?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateEntityResult {
  readonly entityId: EntityId;
  readonly revisionId: RevisionId;
}

export interface CommitRevisionInput {
  readonly entityId: EntityId;
  readonly content: ContentSource;
  readonly expectedHead?: RevisionId;
  readonly metadata?: Record<string, unknown>;
  readonly sourceKind?: SourceKind;
}

export interface CommitRevisionResult {
  readonly entityId: EntityId;
  readonly revisionId: RevisionId;
  readonly previousHead: RevisionId;
}

export interface EntityRecord {
  readonly id: EntityId;
  readonly createdAt: number;
  readonly originalName?: string;
  readonly mediaType?: string;
  readonly metadata: Record<string, unknown>;
  readonly deletedAt?: number;
}

export interface RevisionRecord {
  readonly id: RevisionId;
  readonly entityId: EntityId;
  readonly manifestHash: ContentHash;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly sourceKind: SourceKind;
  readonly metadata: Record<string, unknown>;
  readonly parents: readonly RevisionId[];
}

export interface MaterializeInput {
  readonly entityId: EntityId;
  readonly revision?: RevisionId | 'head';
  readonly destinationPath: string;
  readonly overwrite?: boolean;
}

export interface VerifyInput {
  readonly entityId?: EntityId;
}

export type VerifyIssue =
  | {
      readonly kind: 'missingObject';
      readonly hash: ContentHash;
      readonly path: string;
    }
  | {
      readonly kind: 'corruptObject';
      readonly hash: ContentHash;
      readonly path: string;
    }
  | {
      readonly kind: 'lengthMismatch';
      readonly revisionId: RevisionId;
      readonly expected: number;
      readonly actual: number;
    };

export interface VerifyResult {
  readonly ok: boolean;
  readonly issues: readonly VerifyIssue[];
}

export interface VersionedEntityStore {
  /** Creates an entity and its initial revision from the supplied content. */
  readonly create: (input: CreateEntityInput) => Promise<CreateEntityResult>;

  /** Creates a new immutable revision and updates the entity's current head. */
  readonly commit: (
    input: CommitRevisionInput
  ) => Promise<CommitRevisionResult>;

  /** Returns the metadata and current state of an entity. */
  readonly getEntity: (entityId: EntityId) => Promise<EntityRecord>;

  /** Returns a specific revision, or the entity's current head by default. */
  readonly getRevision: (
    entityId: EntityId,
    revision?: RevisionId | 'head'
  ) => Promise<RevisionRecord>;

  /** Returns the revisions belonging to an entity. */
  readonly listRevisions: (entityId: EntityId) => Promise<RevisionRecord[]>;

  /** Opens a readable stream for a specific revision or the current head. */
  readonly openRead: (
    entityId: EntityId,
    revision?: RevisionId | 'head'
  ) => Promise<NodeJS.ReadableStream>;

  /** Reads a specific revision or the current head fully into memory. */
  readonly readBytes: (
    entityId: EntityId,
    revision?: RevisionId | 'head'
  ) => Promise<Uint8Array>;

  /** Reconstructs a revision and writes it to the requested filesystem path. */
  readonly materializeToPath: (input: MaterializeInput) => Promise<void>;

  /** Checks stored metadata and content objects for integrity problems. */
  readonly verify: (input?: VerifyInput) => Promise<VerifyResult>;
}

export interface CreateVersionedEntityStoreOptions {
  readonly root: string;
  readonly readBytesLimit?: number;
}
