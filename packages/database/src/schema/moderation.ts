import { foreignKey, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { channels, lineages } from './game.ts';

export const lineageBlocks = pgTable(
  'lineage_blocks',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    lineageId: uuid('lineage_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId, t.lineageId] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    foreignKey({
      columns: [t.worldId, t.lineageId],
      foreignColumns: [lineages.worldId, lineages.id],
    }),
  ],
);
