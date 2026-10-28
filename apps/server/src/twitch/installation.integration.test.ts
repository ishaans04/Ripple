import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { enrollChannel, ensureInstallation } from './installation.ts';
import type { TwitchConfig } from './security.ts';
export const testTwitchConfig = (): TwitchConfig => ({
  origin: 'https://ripple.example',
  clientId: 'testapplication',
  clientSecret: 'private-secret',
  webhookSecret: 'w'.repeat(64),
  encryptionKey: randomBytes(32).toString('base64'),
  actorKey: randomBytes(32).toString('base64'),
  operatorSecret: 'o'.repeat(40),
});
describe('durable Twitch installation', () => {
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
  it('creates exactly one live world under concurrent startup and refuses identity-key drift', async () => {
    const config = testTwitchConfig();
    const worlds = await Promise.all([
      ensureInstallation(pool, config),
      ensureInstallation(pool, config),
    ]);
    expect(worlds[0]).toBe(worlds[1]);
    await expect(
      ensureInstallation(pool, { ...config, actorKey: randomBytes(32).toString('base64') }),
    ).rejects.toThrow('ACTOR_HASH_KEY changed');
    const worldId = worlds[0]!;
    const a = await transaction(pool, (c) => enrollChannel(c, worldId, '123', 'broadcaster'));
    const b = await transaction(pool, (c) => enrollChannel(c, worldId, '123', 'broadcaster'));
    expect(a).toBe(b);
    expect(
      (
        await pool.query(
          'select online,healthy,initial_online,initial_healthy from channels where world_id=$1',
          [worldId],
        )
      ).rows,
    ).toEqual([{ online: false, healthy: false, initial_online: false, initial_healthy: false }]);
  });
});
