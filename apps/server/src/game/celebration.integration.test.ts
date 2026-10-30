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
import { readSnapshot } from './snapshot.ts';
import { exportAcceptedChannel, replayAcceptedChannel, canonicalGameProjection } from './replay.ts';

describe('optional paid-event celebrations', () => {
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
  async function send(world: SyntheticWorld, value: unknown) {
    const accepted = await acceptSyntheticCommand(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      value,
    );
    await settleSyntheticWorld(pool, world);
    return (
      await pool.query<{ result: { code: string } }>(
        'select result from game_events where world_id=$1 and channel_id=$2 and sequence=$3',
        [world.worldId, world.channelId, accepted.sequence],
      )
    ).rows[0]?.result.code;
  }
  async function gameState(world: SyntheticWorld) {
    return (
      await pool.query(
        `select (select jsonb_agg(to_jsonb(o)-'version' order by id) from organisms o where world_id=$1) as organisms,
        (select jsonb_agg(jsonb_build_object('id',id,'counts',checkpoint->'counts','votes',vote_count,'contributions',contributions,'accounts',distinct_accounts) order by number) from rounds where world_id=$1) as rounds,
        (select count(*) from votes where world_id=$1) as votes,
        (select count(*) from activity_contributions where world_id=$1) as activity`,
        [world.worldId],
      )
    ).rows[0] as unknown;
  }

  it('shows at most one celebration per minute with no effect on genes, energy, votes or activity', async () => {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(world, syntheticSeedCommand());
    await send(world, { type: 'vote', actorKey: 'private-voter', choice: 1 });
    await send(world, { type: 'activity', actorKey: 'private-chatter' });
    const before = await gameState(world);
    expect(await send(world, { type: 'celebration', kind: 'cheer' })).toBe('APPLIED');
    const first = (await readSnapshot(pool, world.worldId, world.channelId))!.payload.celebration;
    expect(first).toMatchObject({ kind: 'cheer' });
    for (const kind of ['subscription', 'hype_train', 'cheer'])
      expect(await send(world, { type: 'celebration', kind })).toBe('NO_CHANGE');
    expect((await readSnapshot(pool, world.worldId, world.channelId))!.payload.celebration).toEqual(
      first,
    );
    expect(await gameState(world)).toEqual(before);
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), 60_000);
    const advanced = await gameState(world);
    expect(await send(world, { type: 'celebration', kind: 'hype_train' })).toBe('APPLIED');
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))!.payload.celebration,
    ).toMatchObject({ kind: 'hype_train' });
    expect(await gameState(world)).toEqual(advanced);
    const replay = await replayAcceptedChannel(pool, await exportAcceptedChannel(pool, world));
    expect(await canonicalGameProjection(pool, replay)).toBe(
      await canonicalGameProjection(pool, world),
    );
  });

  it('records nothing while the broadcaster hides celebrations', async () => {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(world, syntheticSeedCommand());
    const before = await gameState(world);
    await send(world, {
      type: 'display',
      preferences: {
        layout: 'compact',
        reducedMotion: false,
        familyNews: true,
        celebrations: false,
      },
    });
    expect(await send(world, { type: 'celebration', kind: 'subscription' })).toBe('NO_CHANGE');
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))!.payload.celebration,
    ).toBeNull();
    expect(await gameState(world)).toEqual(before);
    await expect(
      pool.query(
        `update channel_play set celebration='{"kind":"donation","atMs":1}' where world_id=$1`,
        [world.worldId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
