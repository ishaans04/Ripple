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
  uuid,
} from 'drizzle-orm/pg-core';
import { worlds } from './worlds.ts';
import { channels } from './game.ts';

export const twitchInstallations = pgTable('twitch_installations', {
  clientId: text('client_id').primaryKey(),
  worldId: uuid('world_id')
    .notNull()
    .unique()
    .references(() => worlds.id),
  actorKeyFingerprint: text('actor_key_fingerprint').notNull(),
});
export const oauthStates = pgTable(
  'oauth_states',
  {
    hash: text('hash').primaryKey(),
    browserHash: text('browser_hash').notNull(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id),
    purpose: text('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('oauth_state_purpose', sql`${t.purpose} in ('broadcaster','bot','artist')`),
    index('oauth_states_expiry_idx').on(t.expiresAt),
  ],
);
export const twitchChannels = pgTable(
  'twitch_channels',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    categoryId: text('category_id'),
    lifecycleAt: timestamp('lifecycle_at', { withTimezone: true }),
    categoryAt: timestamp('category_at', { withTimezone: true }),
    inputError: text('input_error'),
    visitorPolicy: text('visitor_policy').notNull().default('ask'),
    lastSeedAt: timestamp('last_seed_at', { withTimezone: true }),
    seedCooldownMs: integer('seed_cooldown_ms').notNull().default(180000),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    check('twitch_visitor_policy', sql`${t.visitorPolicy} in ('ask','accept','reject')`),
  ],
);
export const twitchSubscriptions = pgTable(
  'twitch_subscriptions',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    type: text('type').notNull(),
    version: text('version').notNull(),
    providerId: text('provider_id').unique(),
    condition: jsonb('condition').notNull(),
    transportHash: text('transport_hash').notNull().default(''),
    status: text('status').notNull(),
    cost: integer('cost').notNull().default(0),
    attemptAt: timestamp('attempt_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId, t.type] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    check('twitch_subscription_cost', sql`${t.cost}>=0`),
  ],
);
export const twitchReceipts = pgTable('twitch_receipts', {
  messageId: text('message_id').primaryKey(),
  payloadHash: text('payload_hash').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
export const botMessages = pgTable(
  'bot_messages',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    key: text('key').notNull(),
    message: text('message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now()+interval '5 minutes'`),
    status: text('status').notNull().default('pending'),
    attemptAt: timestamp('attempt_at', { withTimezone: true }),
    errorCode: text('error_code'),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId, t.key] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    check('bot_message_bounds', sql`length(${t.message}) between 1 and 500`),
    check(
      'bot_message_status',
      sql`${t.status} in ('pending','sending','sent','uncertain','failed')`,
    ),
  ],
);

export const controllerOperations = pgTable(
  'controller_operations',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    key: uuid('key').notNull(),
    requestHash: text('request_hash').notNull(),
    sequence: integer('sequence').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.channelId, t.key] }),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
  ],
);

/** Each HTTP send attempt counts, including a retry of the same outbox row. */
export const botSendAttempts = pgTable(
  'bot_send_attempts',
  {
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bot_attempts_window_idx').on(t.worldId, t.attemptedAt)],
);
