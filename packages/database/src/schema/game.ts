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
import { worlds } from './worlds.ts';

export const rulesets = pgTable(
  'rulesets',
  {
    hash: text('hash').primaryKey(),
    version: text('version').notNull().unique(),
    engineVersion: integer('engine_version').notNull(),
    canonical: text('canonical').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('rulesets_hash_format', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
    check('rulesets_engine_positive', sql`${t.engineVersion} > 0`),
  ],
);

export const channels = pgTable(
  'channels',
  {
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id),
    id: uuid('id').notNull(),
    twitchId: text('twitch_id'),
    label: text('label').notNull(),
    rulesHash: text('rules_hash')
      .notNull()
      .references(() => rulesets.hash),
    seed: text('seed').notNull(),
    /** Versioned round timings and admission policy; immutable during an open round. */
    configuration: jsonb('configuration').notNull(),
    online: boolean('online').notNull().default(false),
    healthy: boolean('healthy').notNull().default(false),
    paused: boolean('paused').notNull().default(false),
    initialOnline: boolean('initial_online').notNull().default(false),
    initialHealthy: boolean('initial_healthy').notNull().default(false),
    initialPaused: boolean('initial_paused').notNull().default(false),
    intakeSequence: integer('intake_sequence').notNull().default(0),
    processedSequence: integer('processed_sequence').notNull().default(0),
    stateVersion: integer('state_version').notNull().default(0),
    lastAcceptedAt: timestamp('last_accepted_at', { withTimezone: true }),
    checksum: text('checksum').notNull().default('0'.repeat(64)),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    unique('channels_world_twitch_unique').on(t.worldId, t.twitchId),
    check(
      'channels_cursor_order',
      sql`0 <= ${t.processedSequence} and ${t.processedSequence} <= ${t.intakeSequence}`,
    ),
    check('channels_version_nonnegative', sql`${t.stateVersion} >= 0`),
    check('channels_label_length', sql`length(${t.label}) between 1 and 80`),
    index('channels_pending_idx')
      .on(t.worldId, t.id)
      .where(sql`${t.processedSequence} < ${t.intakeSequence}`),
  ],
);

export const lineages = pgTable(
  'lineages',
  {
    worldId: uuid('world_id').notNull(),
    id: uuid('id').notNull(),
    originChannelId: uuid('origin_channel_id').notNull(),
    rulesHash: text('rules_hash')
      .notNull()
      .references(() => rulesets.hash),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    foreignKey({
      columns: [t.worldId, t.originChannelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
  ],
);

export const organisms = pgTable(
  'organisms',
  {
    worldId: uuid('world_id').notNull(),
    id: uuid('id').notNull(),
    lineageId: uuid('lineage_id').notNull(),
    parentId: uuid('parent_id'),
    founderId: uuid('founder_id').notNull(),
    generation: integer('generation').notNull(),
    foundingGenome: jsonb('founding_genome').notNull(),
    pulse: integer('pulse').notNull(),
    calm: integer('calm').notNull(),
    grit: integer('grit').notNull(),
    drift: integer('drift').notNull(),
    health: integer('health').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull().default(0),
    appearance: jsonb('appearance').notNull(),
    mutationSlots: jsonb('mutation_slots').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    foreignKey({
      columns: [t.worldId, t.lineageId],
      foreignColumns: [lineages.worldId, lineages.id],
    }),
    foreignKey({
      name: 'organisms_parent_world_fk',
      columns: [t.worldId, t.parentId],
      foreignColumns: [t.worldId, t.id],
    }),
    foreignKey({
      name: 'organisms_founder_world_fk',
      columns: [t.worldId, t.founderId],
      foreignColumns: [t.worldId, t.id],
    }),
    check(
      'organisms_genome_legal',
      sql`${t.pulse} between 0 and 15 and ${t.calm} between 0 and 15 and ${t.grit} between 0 and 15 and ${t.drift} between 0 and 15 and ${t.pulse}+${t.calm}+${t.grit}+${t.drift}=24`,
    ),
    check('organisms_health_bounds', sql`${t.health} between 0 and 100`),
    check('organisms_living_health', sql`${t.status} not in ('ALIVE','HARBOR') or ${t.health}>0`),
    check('organisms_status_valid', sql`${t.status} in ('ALIVE','HARBOR','FOSSIL','ARCHIVED')`),
    check(
      'organisms_generation_bounds',
      sql`(${t.parentId} is null and ${t.generation}=0 and ${t.founderId}=${t.id}) or (${t.parentId} is not null and ${t.parentId}<>${t.id} and ${t.founderId}<>${t.id} and ${t.generation} between 1 and 16)`,
    ),
    check('organisms_version_nonnegative', sql`${t.version} >= 0`),
    index('organisms_parent_idx').on(t.worldId, t.parentId),
    index('organisms_lineage_idx').on(t.worldId, t.lineageId, t.status),
  ],
);

export const residencies = pgTable(
  'residencies',
  {
    worldId: uuid('world_id').notNull(),
    id: uuid('id').notNull(),
    channelId: uuid('channel_id').notNull(),
    organismId: uuid('organism_id').notNull(),
    role: text('role').notNull(),
    arrivalSnapshot: jsonb('arrival_snapshot'),
    completedValidRounds: integer('completed_valid_rounds').notNull().default(0),
    traceQualified: boolean('trace_qualified').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    foreignKey({
      columns: [t.worldId, t.organismId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    check('residencies_role_valid', sql`${t.role} in ('resident','visitor','harbor')`),
    check('residencies_rounds_nonnegative', sql`${t.completedValidRounds} >= 0`),
    uniqueIndex('residencies_active_organism')
      .on(t.worldId, t.organismId)
      .where(sql`${t.endedAt} is null`),
    uniqueIndex('residencies_active_role')
      .on(t.worldId, t.channelId, t.role)
      .where(sql`${t.endedAt} is null and ${t.role} in ('resident','visitor')`),
  ],
);
