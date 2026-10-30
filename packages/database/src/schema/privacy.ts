import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { uuid } from 'drizzle-orm/pg-core';
import { worlds } from './worlds.ts';
import { sql } from 'drizzle-orm';

/** Erasable identity mapping; accepted commands contain only the random key and credit token. */
export const artistIdentities = pgTable(
  'artist_identities',
  {
    worldId: uuid('world_id').notNull(),
    subjectHash: text('subject_hash').notNull(),
    artistKey: text('artist_key').notNull(),
    creditToken: text('credit_token').notNull(),
    login: text('login').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now()+interval '30 days'`),
  },
  (t) => [
    primaryKey({ columns: [t.worldId, t.subjectHash] }),
    unique().on(t.worldId, t.artistKey),
    unique().on(t.creditToken),
    foreignKey({ columns: [t.worldId], foreignColumns: [worlds.id] }),
    index('artist_identities_expiry').on(t.expiresAt),
  ],
);
export const privacyErasures = pgTable(
  'privacy_erasures',
  {
    worldId: uuid('world_id')
      .notNull()
      .references(() => worlds.id),
    artistKey: text('artist_key').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.artistKey] })],
);
