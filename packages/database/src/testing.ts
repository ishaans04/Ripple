import { randomBytes } from 'node:crypto';
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
        await client.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await client.end();
      }
    },
  };
}
