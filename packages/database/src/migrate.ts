import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

/** Resolves to packages/database/migrations from both src/ and dist/. */
export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

const migrationsSchema = 'drizzle';
const migrationsTable = '__drizzle_migrations';

/**
 * Session-level advisory lock key held while migrating, so concurrently starting
 * instances apply each migration exactly once. Arbitrary but fixed: 'RIPPLEMG'.
 */
const MIGRATION_LOCK_KEY = '5927049098331875655';

export type MigrationStatus = 'current' | 'pending';

export interface MigrationResult {
  applied: number;
  total: number;
}

async function appliedCount(client: pg.PoolClient): Promise<number> {
  const table = await client.query<{ exists: boolean }>(
    'select to_regclass($1) is not null as exists',
    [`${migrationsSchema}.${migrationsTable}`],
  );
  if (!table.rows[0]?.exists) return 0;
  const rows = await client.query<{ count: string }>(
    `select count(*) as count from "${migrationsSchema}"."${migrationsTable}"`,
  );
  return Number(rows.rows[0]?.count ?? 0);
}

/** Apply pending migrations under the deployment lock. Safe to call from many processes. */
export async function runMigrations(pool: pg.Pool): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const before = await appliedCount(client);
      await migrate(drizzle({ client }), { migrationsFolder, migrationsSchema, migrationsTable });
      const after = await appliedCount(client);
      return { applied: after - before, total: after };
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/**
 * Compare the newest applied migration with the newest migration shipped in this build,
 * using the same ordering rule Drizzle uses to decide what to apply.
 */
export async function getMigrationStatus(pool: pg.Pool): Promise<MigrationStatus> {
  const latestShipped = readMigrationFiles({ migrationsFolder }).at(-1)?.folderMillis;
  if (latestShipped === undefined) return 'current';

  const table = await pool.query<{ exists: boolean }>(
    'select to_regclass($1) is not null as exists',
    [`${migrationsSchema}.${migrationsTable}`],
  );
  if (!table.rows[0]?.exists) return 'pending';

  const latest = await pool.query<{ created_at: string | null }>(
    `select max(created_at) as created_at from "${migrationsSchema}"."${migrationsTable}"`,
  );
  const latestApplied = latest.rows[0]?.created_at ?? null;
  if (latestApplied === null) return 'pending';
  return Number(latestApplied) >= latestShipped ? 'current' : 'pending';
}
