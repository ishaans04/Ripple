import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { channels } from './game.ts';

/** Owner-requested synthetic time changes, with durable retry protection. */
export const sandboxClockSteps = pgTable(
  'sandbox_clock_steps',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    operationId: uuid('operation_id').notNull(),
    deltaMs: integer('delta_ms').notNull(),
    fromAt: timestamp('from_at', { withTimezone: true }).notNull(),
    toAt: timestamp('to_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.operationId] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    check(
      'sandbox_clock_step_bounds',
      sql`${t.deltaMs} between 1 and 300000 and extract(epoch from (${t.toAt}-${t.fromAt}))*1000=${t.deltaMs}`,
    ),
  ],
);
