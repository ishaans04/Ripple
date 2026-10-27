import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.ts';
import { acquireRuntimeLease, releaseRuntimeLease } from './runtime-lease.ts';
import { createTemporaryDatabase, type TemporaryDatabase } from './testing.ts';

describe('runtime ownership', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
    await temporary.drop();
  });
  it('has one owner, renews it, and allows takeover only after expiry', async () => {
    const first = randomUUID(),
      second = randomUUID();
    expect(await acquireRuntimeLease(pool, first)).toEqual({ acquired: true, takeover: true });
    expect(await acquireRuntimeLease(pool, second)).toEqual({ acquired: false, takeover: false });
    expect(await acquireRuntimeLease(pool, first)).toEqual({ acquired: true, takeover: false });
    await releaseRuntimeLease(pool, first);
    expect(await acquireRuntimeLease(pool, second)).toEqual({ acquired: true, takeover: true });
    await releaseRuntimeLease(pool, first);
    expect(await acquireRuntimeLease(pool, first)).toEqual({ acquired: false, takeover: false });
  });
  it('marks an expired self-owned lease as an untrustworthy process gap', async () => {
    const owner = randomUUID();
    await pool.query('delete from runtime_leases');
    await acquireRuntimeLease(pool, owner);
    await releaseRuntimeLease(pool, owner);
    expect(await acquireRuntimeLease(pool, owner)).toEqual({ acquired: true, takeover: true });
  });
});
