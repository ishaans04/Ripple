import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import {
  createTemporaryDatabase,
  createTestChannel,
  type TemporaryDatabase,
} from '@ripple/database/testing';
import { sha256Hex } from '@ripple/engine';
import { acceptSyntheticCommand, createSyntheticWorld, syntheticSeedCommand } from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { readSnapshot } from './snapshot.ts';

describe('isolated synthetic clock adapter', () => {
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
  async function start() {
    const world = await createSyntheticWorld(pool);
    await acceptSyntheticCommand(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      syntheticSeedCommand(),
    );
    await settleSyntheticWorld(pool, world);
    return world;
  }
  it('runs persisted cutoff jobs chronologically and makes a repeated clock step idempotent', async () => {
    const world = await start(),
      operation = randomUUID();
    const result = await advanceSyntheticClock(
      pool,
      world,
      world.ownerCapability,
      operation,
      16_000,
    );
    expect(result).toMatchObject({ duplicate: false, pending: false });
    const before = await readSnapshot(pool, world.worldId, world.channelId);
    expect(before?.payload.round).toMatchObject({ phase: 'VOTING', number: 2 });
    expect(before?.payload.organism?.health).toBe(70);
    const replay = await advanceSyntheticClock(
      pool,
      world,
      world.ownerCapability,
      operation,
      16_000,
    );
    expect(replay).toMatchObject({ duplicate: true, toAtMs: result.toAtMs, processed: 0 });
    expect((await readSnapshot(pool, world.worldId, world.channelId))?.version).toBe(
      before?.version,
    );
  });
  it('serializes identical concurrent advances into a single time change', async () => {
    const world = await start(),
      operation = randomUUID();
    const results = await Promise.all([
      advanceSyntheticClock(pool, world, world.ownerCapability, operation, 100),
      advanceSyntheticClock(pool, world, world.ownerCapability, operation, 100),
    ]);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.toAtMs)).size).toBe(1);
    await expect(
      advanceSyntheticClock(pool, world, world.ownerCapability, operation, 200),
    ).rejects.toThrow('different clock change');
  });
  it('keeps paused time and genes fixed through a long synthetic gap', async () => {
    const world = await start();
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), {
      type: 'pause',
      reason: 'manual',
    });
    await settleSyntheticWorld(pool, world);
    const before = await readSnapshot(pool, world.worldId, world.channelId);
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), 60_000);
    const after = await readSnapshot(pool, world.worldId, world.channelId);
    expect(after?.payload.round?.clock).toEqual(before?.payload.round?.clock);
    expect(after?.payload.organism).toEqual(before?.payload.organism);
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), {
      type: 'resume',
    });
    await settleSyntheticWorld(pool, world);
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), 3200);
    expect((await readSnapshot(pool, world.worldId, world.channelId))?.payload.round?.phase).toBe(
      'OBSERVING',
    );
  });
  it('rejects read-only credentials and live-world clock processing on the server', async () => {
    const world = await start();
    await expect(
      advanceSyntheticClock(pool, world, world.readCapability, randomUUID(), 100),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const live = await createTestChannel(pool, 'live'),
      owner = 'test-owner';
    await pool.query('update worlds set owner_capability_hash=$2 where id=$1', [
      live.worldId,
      sha256Hex(owner),
    ]);
    await expect(advanceSyntheticClock(pool, live, owner, randomUUID(), 100)).rejects.toMatchObject(
      { code: 'WRONG_WORLD_MODE' },
    );
    await expect(settleSyntheticWorld(pool, live)).rejects.toMatchObject({
      code: 'WRONG_WORLD_MODE',
    });
  });
});
