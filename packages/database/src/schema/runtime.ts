import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Operational ownership only; game state stays in world-scoped ordered records. */
export const runtimeLeases = pgTable('runtime_leases', {
  name: text('name').primaryKey(),
  owner: uuid('owner').notNull(),
  fence: integer('fence').notNull(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
});
