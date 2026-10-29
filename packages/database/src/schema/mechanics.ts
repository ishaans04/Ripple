import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { channels, lineages, organisms, rulesets } from './game.ts';
import { rounds } from './rounds.ts';

export const transfers = pgTable(
  'transfers',
  {
    worldId: uuid('world_id').notNull(),
    id: uuid('id').notNull(),
    receiptId: text('receipt_id').notNull(),
    sourceChannelId: uuid('source_channel_id').notNull(),
    destinationChannelId: uuid('destination_channel_id'),
    destinationTwitchId: text('destination_twitch_id').notNull(),
    sourceVersion: integer('source_version').notNull(),
    parentId: uuid('parent_id'),
    childId: uuid('child_id'),
    version: integer('version').notNull().default(0),
    destinationSequence: integer('destination_sequence'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    outcome: text('outcome').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    unique('transfers_receipt_unique').on(t.worldId, t.receiptId),
    foreignKey({
      columns: [t.worldId, t.sourceChannelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    foreignKey({
      columns: [t.worldId, t.destinationChannelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    foreignKey({
      columns: [t.worldId, t.parentId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    foreignKey({
      columns: [t.worldId, t.childId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    check('transfers_version_nonnegative', sql`${t.sourceVersion} >= 0`),
    index('transfers_pending_idx').on(t.worldId, t.destinationChannelId, t.outcome, t.expiresAt),
  ],
);

export const dormantMutations = pgTable(
  'dormant_mutations',
  {
    lifetime: jsonb('lifetime').notNull(),
    version: integer('version').notNull().default(0),
    consumption: jsonb('consumption'),
    worldId: uuid('world_id').notNull(),
    id: uuid('id').notNull(),
    organismId: uuid('organism_id').notNull(),
    sourceRoundId: uuid('source_round_id').notNull(),
    template: jsonb('template').notNull(),
    provenance: jsonb('provenance').notNull(),
    remainingHops: integer('remaining_hops').notNull(),
    remainingRounds: integer('remaining_rounds').notNull(),
    status: text('status').notNull(),
    offered: boolean('offered').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    foreignKey({
      columns: [t.worldId, t.organismId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    foreignKey({
      columns: [t.worldId, t.sourceRoundId],
      foreignColumns: [rounds.worldId, rounds.id],
    }),
    check(
      'dormant_lifetime_nonnegative',
      sql`${t.remainingHops} >= 0 and ${t.remainingRounds} >= 0`,
    ),
    check('dormant_status_valid', sql`${t.status} in ('active','consumed','expired','replaced')`),
    check(
      'dormant_lifetime_bounds',
      sql`${t.remainingRounds}<=3 and ${t.remainingHops}<=16 and ${t.version}>=0`,
    ),
    check(
      'dormant_lifetime_consistent',
      sql`valid_mechanic_lifetime(${t.lifetime},${t.sourceRoundId},${t.remainingRounds})`,
    ),
    uniqueIndex('dormant_one_active')
      .on(t.worldId, t.organismId)
      .where(sql`${t.status}='active'`),
  ],
);

export const habitatTraces = pgTable(
  'habitat_traces',
  {
    lifetime: jsonb('lifetime').notNull(),
    qualifyingRoundId: uuid('qualifying_round_id').notNull(),
    worldId: uuid('world_id').notNull(),
    id: uuid('id').notNull(),
    channelId: uuid('channel_id').notNull(),
    emitterId: uuid('emitter_id').notNull(),
    template: text('template').notNull(),
    status: text('status').notNull(),
    remainingRounds: integer('remaining_rounds').notNull(),
    version: integer('version').notNull(),
    decision: jsonb('decision').notNull(),
    provenance: jsonb('provenance').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    foreignKey({
      columns: [t.worldId, t.emitterId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    check('traces_template_valid', sql`${t.template} in ('charged','recovery','shelter')`),
    check(
      'traces_status_valid',
      sql`${t.status} in ('pending','active','cleared','expired','replaced','rejected')`,
    ),
    check('traces_counts_nonnegative', sql`${t.remainingRounds} >= 0 and ${t.version} >= 0`),
    check('trace_lifetime_bounds', sql`${t.remainingRounds}<=3`),
    check(
      'trace_lifetime_consistent',
      sql`valid_mechanic_lifetime(${t.lifetime},${t.qualifyingRoundId},${t.remainingRounds})`,
    ),
    foreignKey({
      columns: [t.worldId, t.qualifyingRoundId],
      foreignColumns: [rounds.worldId, rounds.id],
    }),
    uniqueIndex('traces_one_active')
      .on(t.worldId, t.channelId)
      .where(sql`${t.status}='active'`),
  ],
);

export const ancestorTrials = pgTable(
  'ancestor_trials',
  {
    rulesHash: text('rules_hash')
      .notNull()
      .references(() => rulesets.hash),
    engineVersion: integer('engine_version').notNull().default(1),
    worldId: uuid('world_id').notNull(),
    roundId: uuid('round_id').notNull(),
    organismId: uuid('organism_id').notNull(),
    ancestorId: uuid('ancestor_id').notNull(),
    matchedInputs: jsonb('matched_inputs').notNull(),
    result: jsonb('result').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.roundId, t.organismId] }),
    foreignKey({ columns: [t.worldId, t.roundId], foreignColumns: [rounds.worldId, rounds.id] }),
    foreignKey({
      columns: [t.worldId, t.organismId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    foreignKey({
      columns: [t.worldId, t.ancestorId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
  ],
);

export const descendantCursors = pgTable(
  'descendant_cursors',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    lineageId: uuid('lineage_id').notNull(),
    version: integer('version').notNull(),
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
    check('descendant_cursors_nonnegative', sql`${t.version} >= 0`),
  ],
);

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    id: uuid('id').notNull(),
    type: text('type').notNull(),
    aggregates: jsonb('aggregates').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    index('analytics_type_time_idx').on(t.worldId, t.type, t.createdAt),
  ],
);
