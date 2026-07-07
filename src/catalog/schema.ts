import { relations } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const objects = sqliteTable('objects', {
  hash: text('hash').primaryKey(),
  kind: text('kind', { enum: ['chunk', 'manifest'] }).notNull(),
  rawLength: integer('raw_length').notNull(),
  storedLength: integer('stored_length').notNull(),
  codec: text('codec', { enum: ['identity'] }).notNull(),
  relativePath: text('relative_path').notNull(),
  createdAt: integer('created_at').notNull()
});

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  manifestHash: text('manifest_hash')
    .notNull()
    .references(() => objects.hash),
  byteLength: integer('byte_length').notNull(),
  createdAt: integer('created_at').notNull()
});

export const globalMetadata = sqliteTable('global_metadata', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull()
});

export const fileRelations = relations(files, ({ one }) => ({
  manifest: one(objects, {
    fields: [files.manifestHash],
    references: [objects.hash]
  })
}));

export const schema = {
  objects,
  files,
  globalMetadata,
  fileRelations
};
