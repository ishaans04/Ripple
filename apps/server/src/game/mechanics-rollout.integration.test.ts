import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import {
  canonicalGameProjection,
  exportAcceptedChannel,
  replayAcceptedChannel,
  verifyAcceptedRecords,
} from './replay.ts';
import { readSnapshot } from './snapshot.ts';

describe('recorded mechanics opt-in at a safe round opening', () => {
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
  async function send(world: SyntheticWorld, value: unknown, receipt: string = randomUUID()) {
    await acceptSyntheticCommand(pool, world, world.ownerCapability, receipt, value);
    await settleSyntheticWorld(pool, world);
  }
  async function advance(world: SyntheticWorld, ms: number) {
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), ms);
  }
  async function view(world: SyntheticWorld) {
    return (await readSnapshot(pool, world.worldId, world.channelId))!;
  }
  async function checkpoint(world: SyntheticWorld) {
    return (
      await pool.query(
        'select checkpoint from rounds where world_id=$1 and channel_id=$2 order by number desc limit 1',
        [world.worldId, world.channelId],
      )
    ).rows[0] as { checkpoint: unknown };
  }
  async function activity(world: SyntheticWorld) {
    for (const actorKey of ['a', 'b', 'c']) await send(world, { type: 'activity', actorKey });
  }
  it.each(['VOTING', 'OBSERVING'] as const)(
    'preserves the existing %s checkpoint and legacy result, then replays the recorded upgrade',
    async (phase) => {
      const world = await createSyntheticWorld(pool, { mechanicsVersion: 0 });
      await send(world, syntheticSeedCommand());
      if (phase === 'OBSERVING') await advance(world, 3200);
      const before = await checkpoint(world),
        version = (await view(world)).version,
        receipt = randomUUID();
      await send(world, { type: 'enableMechanics', expectedVersion: version }, receipt);
      await send(world, { type: 'enableMechanics', expectedVersion: version }, receipt);
      expect(await checkpoint(world)).toEqual(before);
      expect((await view(world)).payload.mechanics).toMatchObject({
        version: 0,
        enableRequested: true,
      });
      await send(world, { type: 'enableMechanics' });
      expect((await exportAcceptedChannel(pool, world)).records.at(-1)!.result.code).toBe(
        'NO_CHANGE',
      );
      if (phase === 'VOTING') await advance(world, 3200);
      await activity(world);
      await advance(world, 12000);
      const old = (await view(world)).payload.round!;
      expect(old.analysis).toMatchObject({
        mechanicsVersion: 0,
        alternative: null,
        participants: [{ ancestor: null }],
      });
      expect((await view(world)).payload.mechanics.version).toBe(0);
      await advance(world, 800);
      expect((await view(world)).payload.mechanics).toMatchObject({
        version: 1,
        enableRequested: false,
      });
      expect((await view(world)).payload.round!.choicePreview).toMatchObject({
        status: 'estimate',
      });
      await advance(world, 3200);
      await activity(world);
      await advance(world, 12000);
      expect((await view(world)).payload.round!.analysis).toMatchObject({
        mechanicsVersion: 1,
        participants: [{ ancestor: { engineVersion: 1 } }],
        alternative: { confidence: 'confident' },
      });
      const bundle = await exportAcceptedChannel(pool, world);
      expect(bundle.initialMechanicsVersion).toBe(0);
      const replay = await replayAcceptedChannel(pool, bundle);
      expect(await canonicalGameProjection(pool, replay)).toBe(
        await canonicalGameProjection(pool, world),
      );
      const missingPolicy = structuredClone(bundle);
      delete missingPolicy.mechanicsPolicy;
      expect(() => {
        verifyAcceptedRecords(missingPolicy);
      }).toThrow('matching frozen policy');
    },
  );
  it('holds the request through pause, offline and interrupted observation without silently adding modifiers', async () => {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 0 });
    await send(world, syntheticSeedCommand());
    await advance(world, 3200);
    await send(world, { type: 'interrupt', reason: 'input_outage' });
    const interrupted = await checkpoint(world);
    await send(world, { type: 'enableMechanics' });
    await send(world, { type: 'pause', reason: 'manual' });
    await send(world, { type: 'stream', online: false });
    await advance(world, 300000);
    expect((await view(world)).payload.mechanics).toMatchObject({
      version: 0,
      enableRequested: true,
    });
    expect(await checkpoint(world)).toEqual(interrupted);
    await send(world, { type: 'integration', online: true, healthy: true });
    await send(world, { type: 'resume' });
    await send(world, { type: 'recover' });
    await activity(world);
    await advance(world, 12000);
    expect((await view(world)).payload.round!.analysis!.mechanicsVersion).toBe(0);
    await advance(world, 800);
    expect((await view(world)).payload.mechanics.version).toBe(1);
  });
  it('leaves an unrequested legacy channel unchanged, applies empty-channel intent only when healthy, and fences stale requests', async () => {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 0 });
    await send(world, { type: 'integration', online: false, healthy: true });
    await send(world, { type: 'enableMechanics', expectedVersion: 0 });
    expect((await view(world)).payload.mechanics.enableRequested).toBe(false);
    expect((await exportAcceptedChannel(pool, world)).records.at(-1)!.result.code).toBe(
      'STALE_VERSION',
    );
    await send(world, { type: 'enableMechanics' });
    expect((await view(world)).payload.mechanics).toMatchObject({
      version: 0,
      enableRequested: true,
    });
    await send(world, { type: 'stream', online: true });
    expect((await view(world)).payload.mechanics).toMatchObject({
      version: 1,
      enableRequested: false,
    });
    expect((await view(world)).payload.round).toBeNull();
    await send(world, { type: 'enableMechanics' });
    expect((await exportAcceptedChannel(pool, world)).records.at(-1)!.result.code).toBe(
      'NO_CHANGE',
    );
    const legacy = await createSyntheticWorld(pool, { mechanicsVersion: 0 });
    await send(legacy, syntheticSeedCommand());
    await advance(legacy, 3200);
    await activity(legacy);
    await advance(legacy, 12000);
    await advance(legacy, 800);
    expect((await view(legacy)).payload.mechanics).toMatchObject({
      version: 0,
      enableRequested: false,
    });
    expect((await view(legacy)).payload.round!.choicePreview).toBeUndefined();
  });
  it('rolls back mechanics, completed-round marker and opening together on failure, then retries once', async () => {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 0 });
    await send(world, syntheticSeedCommand());
    await send(world, { type: 'enableMechanics' });
    await advance(world, 3200);
    await activity(world);
    await advance(world, 12000);
    const before = await canonicalGameProjection(pool, world);
    await pool.query(`create function reject_mechanics_opening() returns trigger language plpgsql as $$ begin raise exception 'opening fault'; end $$;
      create trigger opening_fault before insert on rounds for each row execute function reject_mechanics_opening()`);
    try {
      await expect(advance(world, 800)).rejects.toThrow('opening fault');
      expect(await canonicalGameProjection(pool, world)).toBe(before);
      expect((await view(world)).payload.mechanics).toMatchObject({
        version: 0,
        enableRequested: true,
      });
    } finally {
      await pool.query(
        'drop trigger opening_fault on rounds; drop function reject_mechanics_opening()',
      );
    }
    await settleSyntheticWorld(pool, world);
    expect((await view(world)).payload.mechanics).toMatchObject({
      version: 1,
      enableRequested: false,
    });
    expect((await view(world)).payload.round!.number).toBe(2);
    const bundle = await exportAcceptedChannel(pool, world),
      replay = await replayAcceptedChannel(pool, bundle);
    expect(await canonicalGameProjection(pool, replay)).toBe(
      await canonicalGameProjection(pool, world),
    );
  });
});
