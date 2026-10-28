import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { channels } from './game.ts';

export const oauthGrants = pgTable(
  'oauth_grants',
  {
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id'),
    subject: text('subject').notNull(),
    purpose: text('purpose').notNull(),
    scopes: text('scopes').array().notNull(),
    /** Authenticated ciphertext envelope, including key version; never plaintext tokens. */
    encryptedTokens: jsonb('encrypted_tokens').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    validatedAt: timestamp('validated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    refreshOwner: uuid('refresh_owner'),
    refreshUntil: timestamp('refresh_until', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.purpose, t.subject] }),
    uniqueIndex('oauth_broadcaster_channel_unique')
      .on(t.worldId, t.channelId)
      .where(sql`${t.purpose}='broadcaster'`),
    uniqueIndex('oauth_one_bot_per_world')
      .on(t.worldId)
      .where(sql`${t.purpose}='bot'`),
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    check('oauth_grants_purpose_valid', sql`${t.purpose} in ('broadcaster','bot')`),
    check(
      'oauth_grants_scope_valid',
      sql`(${t.purpose}='bot' and ${t.channelId} is null) or (${t.purpose}='broadcaster' and ${t.channelId} is not null)`,
    ),
  ],
);

export const controllerSessions = pgTable(
  'controller_sessions',
  {
    hash: text('hash').primaryKey(),
    worldId: uuid('world_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    subject: text('subject').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.worldId, t.channelId],
      foreignColumns: [channels.worldId, channels.id],
    }),
    index('controller_sessions_expiry_idx').on(t.expiresAt),
  ],
);

export const overlayCapabilities = pgTable(
  'overlay_capabilities',
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
  ],
);
