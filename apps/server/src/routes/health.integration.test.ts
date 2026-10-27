import { liveHealthSchema, readyHealthSchema } from '@ripple/contracts';
import { createDatabase, runMigrations, type DatabaseHandle } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.ts';

describe('health routes', () => {
  let temporary: TemporaryDatabase;
  let database: DatabaseHandle;
  let app: FastifyInstance;

  beforeEach(async () => {
    temporary = await createTemporaryDatabase();
    database = createDatabase({
      connectionString: temporary.connectionString,
      applicationName: 'ripple-test',
      onIdleClientError: (error) => {
        throw error;
      },
    });
    app = buildApp({ config: { logLevel: 'silent' }, pool: database.pool });
  });

  afterEach(async () => {
    await app.close();
    await database.close();
    await temporary.drop();
  });

  it('reports liveness without consulting dependencies', async () => {
    const response = await app.inject({ url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(liveHealthSchema.parse(response.json())).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('is not ready while migrations are pending', async () => {
    const response = await app.inject({ url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(readyHealthSchema.parse(response.json())).toEqual({
      status: 'not_ready',
      checks: { database: 'ok', migrations: 'pending' },
    });
  });

  it('is ready once the database is migrated', async () => {
    await runMigrations(database.pool);
    const response = await app.inject({ url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { database: 'ok', migrations: 'current' },
    });
  });

  it('reports an unreachable database without leaking its address', async () => {
    const unreachable = createDatabase({
      connectionString: 'postgres://ripple:hidden@127.0.0.1:1/ripple',
      applicationName: 'ripple-test',
      onIdleClientError: (error) => {
        throw error;
      },
    });
    const isolated = buildApp({ config: { logLevel: 'silent' }, pool: unreachable.pool });
    try {
      const response = await isolated.inject({ url: '/health/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'not_ready',
        checks: { database: 'unavailable', migrations: 'unknown' },
      });
      expect(response.body).not.toContain('127.0.0.1');
    } finally {
      await isolated.close();
      await unreachable.close();
    }
  });
});
