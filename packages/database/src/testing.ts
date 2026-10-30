import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

export interface TemporaryDatabase {
  connectionString: string;
  drop: () => Promise<void>;
}

function adminConnectionString(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error(
      'TEST_DATABASE_URL must point at a PostgreSQL server where the user may create databases',
    );
  }
  return url;
}

/**
 * Create an empty, uniquely named database so integration suites exercise real
 * transactions and constraints without sharing state.
 */
export async function createTemporaryDatabase(): Promise<TemporaryDatabase> {
  const adminUrl = adminConnectionString();
  const name = `ripple_test_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;

  return {
    connectionString: url.toString(),
    drop: async () => {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        // pg's Pool.end() resolves once clients are asked to close, before the server sees them
        // disconnect. Forcing the drop then could terminate a closing connection and surface a
        // late 57P01 error, so wait (bounded) for this database's own backends to leave first.
        for (let attempt = 0; attempt < 50; attempt++) {
          const open = await client.query<{ count: number }>(
            'select count(*)::int as count from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()',
            [name],
          );
          if (open.rows[0]?.count === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await client.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await client.end();
      }
    },
  };
}

/** Small real-schema fixture; callers may replace the test rules with engine rules. */
export async function createTestChannel(
  pool: pg.Pool,
  mode: 'live' | 'sandbox' | 'replay' = 'replay',
): Promise<{ worldId: string; channelId: string }> {
  const worldId = randomUUID();
  const channelId = randomUUID();
  const hash = 'd'.repeat(64);
  await pool.query(
    'insert into rulesets (hash,version,engine_version,canonical) values ($1,$2,1,$3) on conflict do nothing',
    [hash, 'database-test', '{}'],
  );
  await pool.query(
    `insert into worlds (id,mode,rules_hash,owner_capability_hash,expires_at) values ($1,$2,$3,$4,now()+interval '1 day')`,
    [worldId, mode, hash, 'e'.repeat(64)],
  );
  await pool.query(
    'insert into channels (world_id,id,label,rules_hash,seed,configuration) values ($1,$2,$3,$4,$5,$6)',
    [worldId, channelId, 'Synthetic test channel', hash, 'fixed-seed', '{}'],
  );
  return { worldId, channelId };
}
