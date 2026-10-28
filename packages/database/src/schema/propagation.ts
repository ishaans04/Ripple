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
  uuid,
} from 'drizzle-orm/pg-core';
import { worlds } from './worlds.ts';
import { channels, organisms } from './game.ts';
import { rounds } from './rounds.ts';
import { transfers } from './mechanics.ts';

export const raidPolicies = pgTable(
  'raid_policies',
  {
    hash: text('hash').primaryKey(),
    version: text('version').notNull().unique(),
    canonical: text('canonical').notNull(),
  },
  (t) => [
    check(
      'raid_policy_hash_valid',
      sql`encode(sha256(convert_to(${t.canonical},'UTF8')),'hex')=${t.hash}`,
    ),
  ],
);
export const worldRaidPolicies = pgTable('world_raid_policies', {
  worldId: uuid('world_id')
    .primaryKey()
    .references(() => worlds.id),
  policyHash: text('policy_hash')
    .notNull()
    .references(() => raidPolicies.hash),
});
export const channelPlay = pgTable(
  'channel_play',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    preparation: text('preparation').notNull().default('neutral'),
    preparationRequested: boolean('preparation_requested').notNull().default(false),
    nonMutationRounds: integer('non_mutation_rounds').notNull().default(0),
    rulesCompatible: boolean('rules_compatible').notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    check('channel_preparation_valid', sql`${t.preparation} in ('shield','reserve','neutral')`),
    check('non_mutation_rounds_valid', sql`${t.nonMutationRounds}>=0`),
  ],
);
export const roundParticipants = pgTable(
  'round_participants',
  {
    worldId: uuid('world_id').notNull(),
    roundId: uuid('round_id').notNull(),
    organismId: uuid('organism_id').notNull(),
    role: text('role').notNull(),
    genome: jsonb('genome').notNull(),
    healthBefore: integer('health_before').notNull(),
    resolution: jsonb('resolution'),
    explanation: jsonb('explanation'),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.roundId, t.organismId] }),
    foreignKey({ columns: [t.worldId, t.roundId], foreignColumns: [rounds.worldId, rounds.id] }),
    foreignKey({
      columns: [t.worldId, t.organismId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    check('participant_role_valid', sql`${t.role} in ('resident','visitor')`),
    check('participant_health_valid', sql`${t.healthBefore} between 1 and 100`),
  ],
);
export const visitorState = pgTable(
  'visitor_state',
  {
    worldId: uuid('world_id').notNull(),
    organismId: uuid('organism_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    transferId: uuid('transfer_id').notNull(),
    welcomed: boolean('welcomed').notNull().default(false),
    arrivalPending: boolean('arrival_pending').notNull().default(true),
    shockReduction: integer('shock_reduction').notNull().default(0),
    shelterPending: boolean('shelter_pending').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.organismId] }),
    foreignKey({
      columns: [t.worldId, t.organismId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    foreignKey({
      columns: [t.worldId, t.transferId],
      foreignColumns: [transfers.worldId, transfers.id],
    }),
    check('visitor_reduction_valid', sql`${t.shockReduction} between 0 and 4`),
  ],
);
export const sourceBlocks = pgTable(
  'source_blocks',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    sourceChannelId: uuid('source_channel_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId, t.sourceChannelId] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    foreignKey({
      columns: [t.worldId, t.sourceChannelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
  ],
);
export const transferTransitions = pgTable(
  'transfer_transitions',
  {
    worldId: uuid('world_id').notNull(),
    transferId: uuid('transfer_id').notNull(),
    version: integer('version').notNull(),
    outcome: text('outcome').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    channelId: uuid('channel_id').notNull(),
    sequence: integer('sequence').notNull(),
    detail: jsonb('detail').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.transferId, t.version] }),
    foreignKey({
      columns: [t.worldId, t.transferId],
      foreignColumns: [transfers.worldId, transfers.id],
    }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    index('transfer_transition_channel_idx').on(t.worldId, t.channelId, t.sequence),
  ],
);
