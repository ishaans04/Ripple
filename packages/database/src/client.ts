import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.ts';

export type RippleDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseOptions {
  connectionString: string;
  applicationName: string;
  maxConnections?: number;
  /**
   * Idle pooled clients can fail when PostgreSQL restarts. pg emits these on the pool,
   * and an unhandled 'error' event would terminate the process, so callers must log them.
   */
  onIdleClientError: (error: Error) => void;
}

export interface DatabaseHandle {
  pool: pg.Pool;
  db: RippleDatabase;
  close: () => Promise<void>;
}

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', options.onIdleClientError);

  return {
    pool,
    db: drizzle({ client: pool, schema }),
    close: () => pool.end(),
  };
}
