import { sql } from 'drizzle-orm';
import {
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
import { channels, organisms, rulesets } from './game.ts';

export const rounds = pgTable(
  'rounds',
  {
    worldId: uuid('world_id').notNull(),
    id: uuid('id').notNull(),
    channelId: uuid('channel_id').notNull(),
    organismId: uuid('organism_id').notNull(),
    number: integer('number').notNull(),
    kind: text('kind').notNull(),
    phase: text('phase').notNull(),
    rulesHash: text('rules_hash')
      .notNull()
      .references(() => rulesets.hash),
    seed: text('seed').notNull(),
    /** Candidates, frozen baseline, and active-time checkpoint; versioned engine state. */
    checkpoint: jsonb('checkpoint').notNull(),
    closeSequence: integer('close_sequence'),
    voteCount: integer('vote_count').notNull().default(0),
    contributions: integer('contributions').notNull().default(0),
    distinctAccounts: integer('distinct_accounts').notNull().default(0),
    burst: integer('burst'),
    confidence: text('confidence'),
    resolution: jsonb('resolution'),
    explanation: jsonb('explanation'),
    visitorResult: jsonb('visitor_result'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    unique('rounds_world_id_channel_unique').on(t.worldId, t.id, t.channelId),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    foreignKey({
      columns: [t.worldId, t.organismId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    uniqueIndex('rounds_channel_number').on(t.worldId, t.channelId, t.number),
    uniqueIndex('rounds_one_open')
      .on(t.worldId, t.channelId)
      .where(sql`${t.completedAt} is null`),
    check('rounds_number_positive', sql`${t.number} > 0`),
    check(
      'rounds_kind_valid',
      sql`${t.kind} in ('MUTATION','WELCOME','TRACE','PREPARATION','STUDIO_SELECTION')`,
    ),
    check(
      'rounds_phase_valid',
      sql`${t.phase} in ('VOTING','OBSERVING','REVEAL','INTERRUPTED','COMPLETE')`,
    ),
    check(
      'rounds_confidence_valid',
      sql`${t.confidence} is null or ${t.confidence} in ('confident','limited','interrupted')`,
    ),
    check(
      'rounds_counts_nonnegative',
      sql`${t.voteCount} >= 0 and ${t.contributions} >= 0 and ${t.distinctAccounts} >= 0`,
    ),
    check('rounds_burst_bounds', sql`${t.burst} is null or ${t.burst} between 0 and 1000`),
  ],
);

export const votes = pgTable(
  'votes',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    roundId: uuid('round_id').notNull(),
    actorKey: text('actor_key').notNull(),
    choice: integer('choice').notNull(),
    acceptedSequence: integer('accepted_sequence').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.roundId, t.actorKey] }),
    foreignKey({
      columns: [t.worldId, t.roundId, t.channelId],
      foreignColumns: [rounds.worldId, rounds.id, rounds.channelId],
    }),
    check('votes_choice_bounds', sql`${t.choice} between 1 and 3`),
    check('votes_sequence_positive', sql`${t.acceptedSequence} > 0`),
  ],
);

/** Scoped account/bucket membership, never raw message text. */
export const activityContributions = pgTable(
  'activity_contributions',
  {
    worldId: uuid('world_id').notNull(),
    roundId: uuid('round_id').notNull(),
    observationEpoch: integer('observation_epoch').notNull(),
    bucket: integer('bucket').notNull(),
    actorKey: text('actor_key').notNull(),
    acceptedSequence: integer('accepted_sequence').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.roundId, t.observationEpoch, t.bucket, t.actorKey] }),
    foreignKey({ columns: [t.worldId, t.roundId], foreignColumns: [rounds.worldId, rounds.id] }),
    check(
      'activity_bucket_bounds',
      sql`${t.bucket} between 0 and 11 and ${t.observationEpoch} >= 0`,
    ),
    index('activity_actor_idx').on(t.worldId, t.roundId, t.observationEpoch, t.actorKey),
  ],
);

export const habitatBaselines = pgTable(
  'habitat_baselines',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    roundId: uuid('round_id').notNull(),
    contributions: integer('contributions').notNull(),
    burst: integer('burst').notNull(),
    frozen: jsonb('frozen').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.roundId] }),
    foreignKey({
      columns: [t.worldId, t.roundId, t.channelId],
      foreignColumns: [rounds.worldId, rounds.id, rounds.channelId],
    }),
    check('baselines_counts_valid', sql`${t.contributions} >= 0 and ${t.burst} between 0 and 1000`),
    index('baselines_recent_idx').on(t.worldId, t.channelId, t.completedAt),
  ],
);
