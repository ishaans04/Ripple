import { sql } from 'drizzle-orm';
import { check, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Live, synthetic sandbox, and replay state never share mutable records. */
export const worldModes = ['live', 'sandbox', 'replay'] as const;
export const worldMode = pgEnum('world_mode', worldModes);

/**
 * Isolated state namespace. Every gameplay table carries a world_id.
 * A world's mode is immutable (enforced by the worlds_mode_immutable trigger).
 */
export const worlds = pgTable(
  'worlds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mode: worldMode('mode').notNull(),
    /** SHA-256 hex of the owner capability; required for sandbox worlds. */
    ownerCapabilityHash: text('owner_capability_hash'),
    /** SHA-256 hex of the immutable ruleset this world runs under. */
    rulesHash: text('rules_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** Explicit synthetic clock; live worlds always use receipt wall time. */
    clockAt: timestamp('clock_at', { withTimezone: true }),
    /** A replay world's source; studio designs keep the source world identity in their hashes. */
    replayOf: uuid('replay_of'),
  },
  (table) => [
    check('worlds_rules_hash_format', sql`${table.rulesHash} ~ '^[0-9a-f]{64}$'`),
    check('worlds_live_clock_real', sql`${table.mode} <> 'live' or ${table.clockAt} is null`),
    check(
      'worlds_owner_capability_hash_format',
      sql`${table.ownerCapabilityHash} is null or ${table.ownerCapabilityHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('worlds_replay_source', sql`${table.replayOf} is null or ${table.mode} = 'replay'`),
    check(
      'worlds_sandbox_owned_and_expiring',
      sql`${table.mode} <> 'sandbox' or (${table.ownerCapabilityHash} is not null and ${table.expiresAt} is not null)`,
    ),
  ],
);
