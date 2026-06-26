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
  readonly create: (input: CreateEntityInput) => Promise<CreateEntityResult>;
  readonly commit: (input: CommitRevisionInput) => Promise<CommitRevisionResult>;
  readonly getEntity: (entityId: EntityId) => Promise<EntityRecord>;
  readonly getRevision: (
    entityId: EntityId,
    revision?: RevisionId | 'head'
  ) => Promise<RevisionRecord>;
  readonly listRevisions: (entityId: EntityId) => Promise<RevisionRecord[]>;
  readonly openRead: (
    entityId: EntityId,
    revision?: RevisionId | 'head'
  ) => Promise<NodeJS.ReadableStream>;
  readonly readBytes: (
    entityId: EntityId,
    revision?: RevisionId | 'head'
  ) => Promise<Uint8Array>;
  readonly materializeToPath: (input: MaterializeInput) => Promise<void>;
  readonly verify: (input?: VerifyInput) => Promise<VerifyResult>;
}

export interface CreateVersionedEntityStoreOptions {
  readonly root: string;
  readonly readBytesLimit?: number;
}
