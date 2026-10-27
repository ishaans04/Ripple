import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { acceptSyntheticCommand, createSyntheticWorld, syntheticSeedCommand } from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import {
  canonicalGameProjection,
  exportAcceptedChannel,
  replayAcceptedChannel,
  verifyAcceptedRecords,
} from './replay.ts';

describe('accepted-record reconstruction', () => {
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
  async function journey() {
    const world = await createSyntheticWorld(pool, { seed: 'replay-evidence' });
    const command = async (value: unknown) => {
      await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), value);
      await settleSyntheticWorld(pool, world);
    };
    await command(syntheticSeedCommand());
    await command({ type: 'vote', actorKey: 'a', choice: 2 });
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), 3200);
    for (const actorKey of ['a', 'b', 'c']) await command({ type: 'activity', actorKey });
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), 12000);
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), 4000);
    await command({ type: 'interrupt', reason: 'input_outage' });
    await command({ type: 'integration', online: true, healthy: true });
    await command({ type: 'recover' });
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), 12000);
    return world;
  }
  it('rebuilds genomes, energy, all round inputs/results, baselines and explanations in an isolated world', async () => {
    const source = await journey(),
      before = await canonicalGameProjection(pool, source);
    const bundle = await exportAcceptedChannel(pool, source);
    await expect(
      pool.query('update votes set choice=3 where world_id=$1', [source.worldId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('update habitat_baselines set burst=0 where world_id=$1', [source.worldId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `update rounds set resolution='{}' where world_id=$1 and completed_at is not null`,
        [source.worldId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(bundle.records.length).toBeGreaterThan(10);
    const replay = await replayAcceptedChannel(pool, bundle);
    expect(replay.worldId).not.toBe(source.worldId);
    expect(await canonicalGameProjection(pool, replay)).toBe(before);
    expect(await canonicalGameProjection(pool, source)).toBe(before);
    expect(
      (await pool.query('select * from overlay_capabilities where world_id=$1', [replay.worldId]))
        .rowCount,
    ).toBe(0);
  }, 20_000);
  it('detects edited commands, broken order, and missing records before reconstruction', async () => {
    const source = await journey(),
      bundle = await exportAcceptedChannel(pool, source);
    const changed = structuredClone(bundle);
    const first = changed.records[0]!;
    first.command = { type: 'pause', reason: 'manual' };
    expect(() => {
      verifyAcceptedRecords(changed);
    }).toThrow('Checksum mismatch');
    expect(() => {
      verifyAcceptedRecords({ ...bundle, records: bundle.records.slice(1) });
    }).toThrow('History gap');
    expect(() => {
      verifyAcceptedRecords({ ...bundle, records: bundle.records.slice(0, -1) });
    }).toThrow('Final channel checksum');
  }, 20_000);
});
