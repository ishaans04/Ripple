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
  uuid,
} from 'drizzle-orm/pg-core';
import { channels } from './game.ts';

export const inbox = pgTable(
  'inbox',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    sequence: integer('sequence').notNull(),
    provider: text('provider').notNull(),
    messageId: text('message_id').notNull(),
    command: jsonb('command').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    errorCode: text('error_code'),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId, t.sequence] }),
    unique('inbox_receipt_unique').on(t.worldId, t.provider, t.messageId),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    check('inbox_sequence_positive', sql`${t.sequence} > 0 and ${t.attempts} >= 0`),
    index('inbox_pending_idx')
      .on(t.worldId, t.channelId, t.sequence)
      .where(sql`${t.processedAt} is null`),
  ],
);

export const inputReceipts = pgTable(
  'input_receipts',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    provider: text('provider').notNull(),
    messageId: text('message_id').notNull(),
    sequence: integer('sequence').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    commandHash: text('command_hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.provider, t.messageId] }),
    unique().on(t.worldId, t.channelId, t.sequence),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
  ],
);
export const gameEvents = pgTable(
  'game_events',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    sequence: integer('sequence').notNull(),
    id: uuid('id').notNull(),
    operationId: text('operation_id').notNull(),
    engineVersion: integer('engine_version').notNull(),
    rulesHash: text('rules_hash').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
    command: jsonb('command').notNull(),
    result: jsonb('result').notNull(),
    dependencies: jsonb('dependencies').notNull(),
    previousChecksum: text('previous_checksum').notNull(),
    checksum: text('checksum').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId, t.sequence] }),
    unique('game_events_world_id_unique').on(t.worldId, t.id),
    unique('game_events_operation_unique').on(t.worldId, t.channelId, t.operationId),
    foreignKey({
      columns: [t.worldId, t.channelId, t.sequence],
      foreignColumns: [inputReceipts.worldId, inputReceipts.channelId, inputReceipts.sequence],
    }),
    check(
      'game_events_checksums_format',
      sql`${t.previousChecksum} ~ '^[0-9a-f]{64}$' and ${t.checksum} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const deadlines = pgTable(
  'deadlines',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    id: uuid('id').notNull(),
    jobKey: text('job_key').notNull(),
    command: jsonb('command').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    remainingMs: integer('remaining_ms').notNull(),
    status: text('status').notNull().default('pending'),
    leaseOwner: uuid('lease_owner'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.id] }),
    unique('deadlines_job_unique').on(t.worldId, t.channelId, t.jobKey),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    check(
      'deadlines_status_valid',
      sql`${t.status} in ('pending','leased','delivered','cancelled')`,
    ),
    check('deadlines_counts_nonnegative', sql`${t.remainingMs} >= 0 and ${t.attempts} >= 0`),
    index('deadlines_due_idx').on(t.status, t.dueAt, t.leaseUntil),
  ],
);

/** Durable per-topic versions. Each gateway reads these independently after commit. */
export const publicUpdates = pgTable(
  'public_updates',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    version: integer('version').notNull(),
    eventId: uuid('event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId, t.version] }),
    unique('public_updates_event_unique').on(t.worldId, t.eventId),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    check('public_updates_version_positive', sql`${t.version} > 0`),
  ],
);

export const gatewayTickets = pgTable(
  'gateway_tickets',
  {
    hash: text('hash').primaryKey(),
    authorityHash: text('authority_hash').notNull().default(''),
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    index('gateway_tickets_expiry_idx').on(t.expiresAt),
  ],
);
