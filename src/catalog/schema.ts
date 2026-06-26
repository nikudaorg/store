import { relations } from 'drizzle-orm';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { SourceKind } from '../api/types.js';

export const entities = sqliteTable('entities', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  originalName: text('original_name'),
  mediaType: text('media_type'),
  metadataJson: text('metadata_json').notNull(),
  deletedAt: integer('deleted_at')
});

export const objects = sqliteTable('objects', {
  hash: text('hash').primaryKey(),
  kind: text('kind', { enum: ['chunk', 'manifest'] }).notNull(),
  rawLength: integer('raw_length').notNull(),
  storedLength: integer('stored_length').notNull(),
  codec: text('codec', { enum: ['identity'] }).notNull(),
  relativePath: text('relative_path').notNull(),
  createdAt: integer('created_at').notNull()
});

export const revisions = sqliteTable('revisions', {
  id: text('id').primaryKey(),
  entityId: text('entity_id')
    .notNull()
    .references(() => entities.id),
  manifestHash: text('manifest_hash')
    .notNull()
    .references(() => objects.hash),
  byteLength: integer('byte_length').notNull(),
  createdAt: integer('created_at').notNull(),
  sourceKind: text('source_kind').$type<SourceKind>().notNull(),
  metadataJson: text('metadata_json').notNull()
});

export const revisionParents = sqliteTable(
  'revision_parents',
  {
    revisionId: text('revision_id')
      .notNull()
      .references(() => revisions.id),
    parentRevisionId: text('parent_revision_id')
      .notNull()
      .references(() => revisions.id),
    position: integer('position').notNull()
  },
  (table) => [
    primaryKey({
      columns: [table.revisionId, table.parentRevisionId]
    })
  ]
);

export const entityHeads = sqliteTable('entity_heads', {
  entityId: text('entity_id')
    .primaryKey()
    .references(() => entities.id),
  revisionId: text('revision_id')
    .notNull()
    .references(() => revisions.id)
});

export const entityRelations = relations(entities, ({ many, one }) => ({
  revisions: many(revisions),
  head: one(entityHeads, {
    fields: [entities.id],
    references: [entityHeads.entityId]
  })
}));

export const revisionRelations = relations(revisions, ({ one, many }) => ({
  entity: one(entities, {
    fields: [revisions.entityId],
    references: [entities.id]
  }),
  manifest: one(objects, {
    fields: [revisions.manifestHash],
    references: [objects.hash]
  }),
  parents: many(revisionParents)
}));

export const revisionParentRelations = relations(revisionParents, ({ one }) => ({
  revision: one(revisions, {
    fields: [revisionParents.revisionId],
    references: [revisions.id]
  }),
  parentRevision: one(revisions, {
    fields: [revisionParents.parentRevisionId],
    references: [revisions.id]
  })
}));

export const entityHeadRelations = relations(entityHeads, ({ one }) => ({
  entity: one(entities, {
    fields: [entityHeads.entityId],
    references: [entities.id]
  }),
  revision: one(revisions, {
    fields: [entityHeads.revisionId],
    references: [revisions.id]
  })
}));

export const schema = {
  entities,
  objects,
  revisions,
  revisionParents,
  entityHeads,
  entityRelations,
  revisionRelations,
  revisionParentRelations,
  entityHeadRelations
};
