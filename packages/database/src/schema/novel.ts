import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import { worlds } from './worlds.ts';
import { channels, lineages, organisms, residencies } from './game.ts';
import { rounds } from './rounds.ts';
import { habitatTraces } from './mechanics.ts';

export const mechanicsPolicies = pgTable(
  'mechanics_policies',
  {
    hash: text('hash').primaryKey(),
    version: text('version').notNull().unique(),
    canonical: text('canonical').notNull(),
  },
  (t) => [
    check(
      'mechanics_policy_hash_valid',
      sql`encode(sha256(convert_to(${t.canonical},'UTF8')),'hex')=${t.hash}`,
    ),
  ],
);
export const worldMechanicsPolicies = pgTable('world_mechanics_policies', {
  worldId: uuid('world_id')
    .primaryKey()
    .references(() => worlds.id),
  policyHash: text('policy_hash')
    .notNull()
    .references(() => mechanicsPolicies.hash),
});
/** The world is the season namespace. An offer consumes the lineage/host qualification once. */
export const traceQualifications = pgTable(
  'trace_qualifications',
  {
    worldId: uuid('world_id').notNull(),
    lineageId: uuid('lineage_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    residencyId: uuid('residency_id').notNull(),
    emitterId: uuid('emitter_id').notNull(),
    qualifyingRoundId: uuid('qualifying_round_id').notNull(),
    traceId: uuid('trace_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.lineageId, t.channelId] }),
    unique('trace_qualification_offer_unique').on(t.worldId, t.traceId),
    foreignKey({
      columns: [t.worldId, t.lineageId],
      foreignColumns: [lineages.worldId, lineages.id],
    }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    foreignKey({
      columns: [t.worldId, t.residencyId],
      foreignColumns: [residencies.worldId, residencies.id],
    }),
    foreignKey({
      columns: [t.worldId, t.emitterId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    foreignKey({
      columns: [t.worldId, t.qualifyingRoundId],
      foreignColumns: [rounds.worldId, rounds.id],
    }),
    foreignKey({
      columns: [t.worldId, t.traceId],
      foreignColumns: [habitatTraces.worldId, habitatTraces.id],
    }),
  ],
);
