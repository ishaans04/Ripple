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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { channels, organisms } from './game.ts';

const nonterminal = sql`phase in ('OPENING','CREATING','VOTING','REVIEW','PENDING_HATCH')`;

/** Per-channel studio settings and availability, kept apart from broadcast status (addendum 7.1). */
export const channelStudio = pgTable(
  'channel_studio',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    settings: jsonb('settings').notNull(),
    availability: text('availability').notNull().default('ACTIVE'),
    availabilitySource: text('availability_source'),
    bridgeScene: text('bridge_scene'),
    bridgeSeenAt: timestamp('bridge_seen_at', { withTimezone: true }),
    bridgeStale: boolean('bridge_stale').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    check(
      'channel_studio_availability_valid',
      sql`${t.availability} in ('ACTIVE','REST','UNKNOWN')`,
    ),
    check(
      'channel_studio_source_valid',
      sql`${t.availabilitySource} is null or ${t.availabilitySource} in ('manual','bridge','stream','integration')`,
    ),
  ],
);

/** A narrow per-channel capability that may only report availability signals (addendum 7.4). */
export const studioBridgeCapabilities = pgTable(
  'studio_bridge_capabilities',
  {
    hash: text('hash').primaryKey(),
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    uniqueIndex('studio_bridge_one_active')
      .on(t.worldId, t.channelId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/** Immutable canonical designs; fossils and descendants keep the exact accepted record. */
export const appearanceBlueprints = pgTable(
  'appearance_blueprints',
  {
    worldId: uuid('world_id').notNull(),
    hash: text('hash').notNull(),
    canonical: text('canonical').notNull(),
    blueprint: jsonb('blueprint').notNull(),
    rendererVersion: text('renderer_version').notNull(),
    template: text('template').notNull(),
    sessionId: uuid('session_id').notNull(),
    parentHash: text('parent_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.hash] }),
    check('appearance_blueprint_hash_format', sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
    check('appearance_blueprint_renderer_known', sql`${t.rendererVersion} = 'shell-v1'`),
    check('appearance_blueprint_size', sql`octet_length(${t.canonical}) <= 8192`),
  ],
);

export const studioSessions = pgTable(
  'studio_sessions',
  {
    worldId: uuid('world_id').notNull(),
    id: uuid('id').notNull(),
    channelId: uuid('channel_id').notNull(),
    organismId: uuid('organism_id').notNull(),
    phase: text('phase').notNull(),
    version: integer('version').notNull().default(0),
    trigger: text('trigger').notNull(),
    challenge: jsonb('challenge').notNull(),
    seed: text('seed').notNull(),
    /** Settings captured at opening; later changes never alter a running session. */
    settings: jsonb('settings').notNull(),
    creationCloseAt: timestamp('creation_close_at', { withTimezone: true }),
    votingCloseAt: timestamp('voting_close_at', { withTimezone: true }),
    reviewExpiresAt: timestamp('review_expires_at', { withTimezone: true }),
    ballotRoundId: uuid('ballot_round_id'),
    shortlist: jsonb('shortlist'),
    selection: jsonb('selection'),
    adaptationId: uuid('adaptation_id'),
    outcome: jsonb('outcome'),
    openedSequence: integer('opened_sequence').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
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
    check(
      'studio_session_phase_valid',
      sql`${t.phase} in ('OPENING','CREATING','VOTING','REVIEW','PENDING_HATCH','COMPLETED','CANCELLED','EXPIRED')`,
    ),
    check('studio_session_trigger_valid', sql`${t.trigger} in ('manual','bridge')`),
    check('studio_session_version_nonnegative', sql`${t.version} >= 0`),
    check(
      'studio_session_terminal_ended',
      sql`(${t.endedAt} is null) = (${t.phase} in ('OPENING','CREATING','VOTING','REVIEW','PENDING_HATCH'))`,
    ),
    uniqueIndex('studio_one_nonterminal_per_channel').on(t.worldId, t.channelId).where(nonterminal),
    index('studio_sessions_channel_idx').on(t.worldId, t.channelId, t.createdAt),
  ],
);

/** Append-only record of every studio phase change and its cause (addendum 8.4). */
export const studioTransitions = pgTable(
  'studio_transitions',
  {
    worldId: uuid('world_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    version: integer('version').notNull(),
    fromPhase: text('from_phase'),
    toPhase: text('to_phase').notNull(),
    event: text('event').notNull(),
    sequence: integer('sequence').notNull(),
    detail: jsonb('detail').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.sessionId, t.version] }),
    foreignKey({
      columns: [t.worldId, t.sessionId],
      foreignColumns: [studioSessions.worldId, studioSessions.id],
    }),
  ],
);

/** Personal proposals; accepted content is immutable and only its status may move forward. */
export const studioProposals = pgTable(
  'studio_proposals',
  {
    worldId: uuid('world_id').notNull(),
    id: uuid('id').notNull(),
    sessionId: uuid('session_id').notNull(),
    artistKey: text('artist_key').notNull(),
    credit: text('credit').notNull(),
    creditOptIn: boolean('credit_opt_in').notNull(),
    revision: integer('revision').notNull(),
    blueprintHash: text('blueprint_hash').notNull(),
    status: text('status').notNull(),
    submittedSequence: integer('submitted_sequence').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    endedSequence: integer('ended_sequence'),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    foreignKey({
      columns: [t.worldId, t.sessionId],
      foreignColumns: [studioSessions.worldId, studioSessions.id],
    }),
    foreignKey({
      columns: [t.worldId, t.blueprintHash],
      foreignColumns: [appearanceBlueprints.worldId, appearanceBlueprints.hash],
    }),
    check(
      'studio_proposal_status_valid',
      sql`${t.status} in ('active','replaced','withdrawn','removed')`,
    ),
    check('studio_proposal_revision_positive', sql`${t.revision} > 0`),
    check('studio_proposal_credit_length', sql`length(${t.credit}) between 1 and 40`),
    uniqueIndex('studio_one_active_proposal_per_artist')
      .on(t.worldId, t.sessionId, t.artistKey)
      .where(sql`${t.status} = 'active'`),
    index('studio_proposals_session_idx').on(t.worldId, t.sessionId, t.status),
  ],
);

/** An approved design waiting for its reserved mutation slot (addendum 13.3). */
export const pendingAdaptations = pgTable(
  'pending_adaptations',
  {
    worldId: uuid('world_id').notNull(),
    id: uuid('id').notNull(),
    sessionId: uuid('session_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    organismId: uuid('organism_id').notNull(),
    blueprintHash: text('blueprint_hash').notNull(),
    template: text('template').notNull(),
    targetSlot: integer('target_slot').notNull(),
    status: text('status').notNull(),
    approval: jsonb('approval').notNull(),
    reason: text('reason'),
    committedRoundId: uuid('committed_round_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    uniqueIndex('pending_adaptation_per_session').on(t.worldId, t.sessionId),
    foreignKey({
      columns: [t.worldId, t.sessionId],
      foreignColumns: [studioSessions.worldId, studioSessions.id],
    }),
    foreignKey({
      columns: [t.worldId, t.organismId],
      foreignColumns: [organisms.worldId, organisms.id],
    }),
    foreignKey({
      columns: [t.worldId, t.blueprintHash],
      foreignColumns: [appearanceBlueprints.worldId, appearanceBlueprints.hash],
    }),
    check(
      'pending_adaptation_status_valid',
      sql`${t.status} in ('pending','committed','released','cancelled','expired')`,
    ),
    check('pending_adaptation_slot_positive', sql`${t.targetSlot} > 0`),
    uniqueIndex('pending_adaptation_one_per_organism')
      .on(t.worldId, t.organismId)
      .where(sql`${t.status} = 'pending'`),
    uniqueIndex('pending_adaptation_one_commit_per_slot')
      .on(t.worldId, t.organismId, t.targetSlot)
      .where(sql`${t.status} = 'committed'`),
  ],
);

export const studioArtistBlocks = pgTable(
  'studio_artist_blocks',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    artistKey: text('artist_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId, t.artistKey] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
  ],
);

/** Identity-only author sessions, separate from broadcaster control (addendum 12.2). */
export const artistSessions = pgTable(
  'artist_sessions',
  {
    hash: text('hash').primaryKey(),
    worldId: uuid('world_id').notNull(),
    artistKey: text('artist_key').notNull(),
    login: text('login').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('artist_sessions_expiry_idx').on(t.expiresAt)],
);
