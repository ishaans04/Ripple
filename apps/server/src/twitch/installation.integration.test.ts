import { randomBytes, randomUUID } from 'node:crypto';
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
  sessionSecret: Buffer.alloc(32, 19).toString('base64'),
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
    const worldId = worlds[0];
    const a = await transaction(pool, (c) => enrollChannel(c, worldId, '123', 'broadcaster'));
    const b = await transaction(pool, (c) => enrollChannel(c, worldId, '123', 'broadcaster'));
    expect(a).toBe(b);
    expect(
      (
        await pool.query<Record<string, unknown>>(
          'select online,healthy,initial_online,initial_healthy from channels where world_id=$1',
          [worldId],
        )
      ).rows,
    ).toEqual([{ online: false, healthy: false, initial_online: false, initial_healthy: false }]);
    expect(
      (
        await pool.query(
          'select initial_mechanics_version from channels where world_id=$1 and id=$2',
          [worldId, a],
        )
      ).rows[0],
    ).toEqual({ initial_mechanics_version: 1 });
    expect(
      (
        await pool.query(
          'select mechanics_version from channel_play where world_id=$1 and channel_id=$2',
          [worldId, a],
        )
      ).rows[0],
    ).toEqual({ mechanics_version: 1 });
    const legacy = randomUUID();
    await pool.query(
      `insert into channels(world_id,id,twitch_id,label,rules_hash,seed,configuration)
      select world_id,$3,'456','Legacy',rules_hash,seed,configuration from channels where world_id=$1 and id=$2`,
      [worldId, a, legacy],
    );
    expect(
      await transaction(pool, (client) =>
        enrollChannel(client, worldId, '456', 'Legacy reauthorized'),
      ),
    ).toBe(legacy);
    expect(
      (
        await pool.query(
          'select initial_mechanics_version from channels where world_id=$1 and id=$2',
          [worldId, legacy],
        )
      ).rows[0],
    ).toEqual({ initial_mechanics_version: 0 });
    expect(
      (
        await pool.query(
          'select mechanics_version,mechanics_requested from channel_play where world_id=$1 and channel_id=$2',
          [worldId, legacy],
        )
      ).rows[0],
    ).toEqual({ mechanics_version: 0, mechanics_requested: false });
  });
});
