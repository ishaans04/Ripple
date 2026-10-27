import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from './client.ts';
import { getMigrationStatus, migrationsFolder, runMigrations } from './migrate.ts';
import { createTemporaryDatabase, type TemporaryDatabase } from './testing.ts';

const shipped = readMigrationFiles({ migrationsFolder }).length;

function connect(connectionString: string): DatabaseHandle {
  return createDatabase({
    connectionString,
    applicationName: 'ripple-test',
    onIdleClientError: (error) => {
      throw error;
    },
  });
}

describe('runMigrations', () => {
  let temporary: TemporaryDatabase;
  let database: DatabaseHandle;

  beforeEach(async () => {
    temporary = await createTemporaryDatabase();
    database = connect(temporary.connectionString);
  });

  afterEach(async () => {
    await database.close();
    await temporary.drop();
  });

  it('reports pending until migrations are applied, then current', async () => {
    expect(await getMigrationStatus(database.pool)).toBe('pending');
    expect(await runMigrations(database.pool)).toEqual({ applied: shipped, total: shipped });
    expect(await getMigrationStatus(database.pool)).toBe('current');
  });

  it('applies nothing on a second run', async () => {
    await runMigrations(database.pool);
    expect(await runMigrations(database.pool)).toEqual({ applied: 0, total: shipped });
  });

  it('applies each migration exactly once when instances start concurrently', async () => {
    const instances = [0, 1, 2, 3].map(() => connect(temporary.connectionString));
    try {
      const results = await Promise.all(instances.map((instance) => runMigrations(instance.pool)));
      expect(results.reduce((sum, result) => sum + result.applied, 0)).toBe(shipped);
      for (const result of results) expect(result.total).toBe(shipped);
    } finally {
      await Promise.all(instances.map((instance) => instance.close()));
    }
  });
});
