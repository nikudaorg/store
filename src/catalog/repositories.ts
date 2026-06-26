import { and, asc, eq, isNull } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type {
  ContentHash,
  EntityId,
  EntityRecord,
  RevisionId,
  RevisionRecord,
  SourceKind
} from '../api/types.js';
import type { StoredObject } from '../storage/object-store.js';
import {
  entities,
  entityHeads,
  objects,
  revisionParents,
  revisions,
  schema
} from './schema.js';

type CatalogOrm = LibSQLDatabase<typeof schema>;
type CatalogTransaction = Parameters<Parameters<CatalogOrm['transaction']>[0]>[0];
type WritableCatalog = CatalogOrm | CatalogTransaction;

export interface CreateEntityRevisionInput {
  readonly entityId: EntityId;
  readonly revisionId: RevisionId;
  readonly manifestHash: ContentHash;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly originalName?: string;
  readonly mediaType?: string;
  readonly entityMetadataJson: string;
  readonly revisionMetadataJson: string;
  readonly sourceKind: SourceKind;
  readonly objects: readonly StoredObject[];
}

export interface CommitEntityRevisionInput {
  readonly entityId: EntityId;
  readonly revisionId: RevisionId;
  readonly previousHead: RevisionId;
  readonly manifestHash: ContentHash;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly metadataJson: string;
  readonly sourceKind: SourceKind;
  readonly objects: readonly StoredObject[];
}

const parseMetadata = (json: string): Record<string, unknown> =>
  JSON.parse(json) as Record<string, unknown>;

export const createRepositories = (db: CatalogOrm) => {
  const entityFromRow = (row: typeof entities.$inferSelect): EntityRecord => ({
    id: row.id,
    createdAt: row.createdAt,
    originalName: row.originalName ?? undefined,
    mediaType: row.mediaType ?? undefined,
    metadata: parseMetadata(row.metadataJson),
    deletedAt: row.deletedAt ?? undefined
  });

  const parentsFor = async (revisionId: RevisionId): Promise<readonly RevisionId[]> =>
    (
      await db
        .select({ parentRevisionId: revisionParents.parentRevisionId })
        .from(revisionParents)
        .where(eq(revisionParents.revisionId, revisionId))
        .orderBy(asc(revisionParents.position))
    ).map((row) => row.parentRevisionId);

  const revisionFromRow = async (
    row: typeof revisions.$inferSelect
  ): Promise<RevisionRecord> => ({
    id: row.id,
    entityId: row.entityId,
    manifestHash: row.manifestHash,
    byteLength: row.byteLength,
    createdAt: row.createdAt,
    sourceKind: row.sourceKind,
    metadata: parseMetadata(row.metadataJson),
    parents: await parentsFor(row.id)
  });

  const getEntity = async (entityId: EntityId): Promise<EntityRecord> => {
    const row = await db.query.entities.findFirst({
      where: and(eq(entities.id, entityId), isNull(entities.deletedAt))
    });
    if (row === undefined) {
      throw Object.assign(new Error(`Entity ${entityId} was not found`), {
        code: 'entityNotFound' as const
      });
    }
    return entityFromRow(row);
  };

  const getHeadRevisionId = async (entityId: EntityId): Promise<RevisionId> => {
    const row = await db.query.entityHeads.findFirst({
      columns: { revisionId: true },
      where: eq(entityHeads.entityId, entityId)
    });
    if (row === undefined) {
      throw Object.assign(new Error(`Entity ${entityId} has no head`), {
        code: 'revisionNotFound' as const
      });
    }
    return row.revisionId;
  };

  const getRevision = async (
    entityId: EntityId,
    revision: RevisionId | 'head' = 'head'
  ): Promise<RevisionRecord> => {
    const revisionId = revision === 'head' ? await getHeadRevisionId(entityId) : revision;
    const row = await db.query.revisions.findFirst({
      where: and(eq(revisions.id, revisionId), eq(revisions.entityId, entityId))
    });
    if (row === undefined) {
      throw Object.assign(
        new Error(`Revision ${revisionId} was not found for ${entityId}`),
        { code: 'revisionNotFound' as const }
      );
    }
    return revisionFromRow(row);
  };

  const listRevisions = async (entityId: EntityId): Promise<RevisionRecord[]> => {
    await getEntity(entityId);
    const rows = await db
      .select()
      .from(revisions)
      .where(eq(revisions.entityId, entityId))
      .orderBy(asc(revisions.createdAt), asc(revisions.id));
    return Promise.all(rows.map(revisionFromRow));
  };

  const insertObjects = async (
    target: WritableCatalog,
    storedObjects: readonly StoredObject[],
    createdAt: number
  ): Promise<void> => {
    if (storedObjects.length === 0) {
      return;
    }
    await target
      .insert(objects)
      .values(
        storedObjects.map((object) => ({
          hash: object.hash,
          kind: object.kind,
          rawLength: object.rawLength,
          storedLength: object.storedLength,
          codec: object.codec,
          relativePath: object.relativePath,
          createdAt
        }))
      )
      .onConflictDoNothing({ target: objects.hash });
  };

  const createEntityRevision = async (
    input: CreateEntityRevisionInput
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      await insertObjects(tx, input.objects, input.createdAt);
      await tx.insert(entities).values({
        id: input.entityId,
        createdAt: input.createdAt,
        originalName: input.originalName,
        mediaType: input.mediaType,
        metadataJson: input.entityMetadataJson
      });
      await tx.insert(revisions).values({
        id: input.revisionId,
        entityId: input.entityId,
        manifestHash: input.manifestHash,
        byteLength: input.byteLength,
        createdAt: input.createdAt,
        sourceKind: input.sourceKind,
        metadataJson: input.revisionMetadataJson
      });
      await tx.insert(entityHeads).values({
        entityId: input.entityId,
        revisionId: input.revisionId
      });
    });
  };

  const commitEntityRevision = async (
    input: CommitEntityRevisionInput
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      await insertObjects(tx, input.objects, input.createdAt);
      await tx.insert(revisions).values({
        id: input.revisionId,
        entityId: input.entityId,
        manifestHash: input.manifestHash,
        byteLength: input.byteLength,
        createdAt: input.createdAt,
        sourceKind: input.sourceKind,
        metadataJson: input.metadataJson
      });
      await tx.insert(revisionParents).values({
        revisionId: input.revisionId,
        parentRevisionId: input.previousHead,
        position: 0
      });
      await tx
        .update(entityHeads)
        .set({ revisionId: input.revisionId })
        .where(eq(entityHeads.entityId, input.entityId));
    });
  };

  const allManifestHashes = async (
    entityId?: EntityId
  ): Promise<readonly ContentHash[]> => {
    const rows =
      entityId === undefined
        ? await db.select({ manifestHash: revisions.manifestHash }).from(revisions)
        : await db
            .select({ manifestHash: revisions.manifestHash })
            .from(revisions)
            .where(eq(revisions.entityId, entityId));
    return rows.map((row) => row.manifestHash);
  };

  return {
    getEntity,
    getHeadRevisionId,
    getRevision,
    listRevisions,
    createEntityRevision,
    commitEntityRevision,
    allManifestHashes
  };
};
