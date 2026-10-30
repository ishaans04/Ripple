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
import { createSyntheticPeer } from './synthetic-peer.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { readSnapshot } from './snapshot.ts';

describe('structural family updates and return digests', () => {
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
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), value);
    await settleSyntheticWorld(pool, world);
  }
  async function advance(world: SyntheticWorld, ms: number) {
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), ms);
  }
  async function observe(world: SyntheticWorld) {
    for (const actorKey of ['private-a', 'private-b', 'private-c'])
      await send(world, { type: 'activity', actorKey });
    await advance(world, 12000);
  }
  async function start() {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 1 }),
      seed = syntheticSeedCommand();
    await send(world, { ...seed, name: 'Home strain' });
    return { world, seed };
  }
  async function peer(world: SyntheticWorld, label: string, policy?: 'accept' | 'reject') {
    const target = await createSyntheticPeer(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      label,
    );
    const host = { ...world, channelId: target.channelId, readCapability: target.readCapability };
    if (policy !== undefined)
      await send(host, { type: 'policy', visitorPolicy: policy, expectedVersion: 0 });
    return host;
  }
  async function raid(source: SyntheticWorld, host: SyntheticWorld) {
    const childId = randomUUID();
    await send(source, {
      type: 'raid',
      transferId: randomUUID(),
      childId,
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: host.channelId,
      destinationTwitchId: host.channelId,
    });
    return childId;
  }
  async function returnSession(world: SyntheticWorld) {
    await send(world, { type: 'stream', online: false });
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))!.payload.familyDigest,
    ).toBeNull();
    await send(world, { type: 'stream', online: true });
    return (await readSnapshot(pool, world.worldId, world.channelId))!.payload.familyDigest;
  }
  async function updates(world: SyntheticWorld, lineageId: string) {
    return (
      await pool.query<{
        sequence: number;
        kind: string;
        organism_id: string;
        channel_id: string | null;
      }>(
        'select sequence,kind,organism_id,channel_id from lineage_updates where world_id=$1 and lineage_id=$2 order by sequence',
        [world.worldId, lineageId],
      )
    ).rows;
  }

  it('records births, admissions, fossils, refusals and earned traces in lineage order', async () => {
    const { world, seed } = await start(),
      settled = await peer(world, 'Settled host', 'accept'),
      contested = await peer(world, 'Contested host', 'accept'),
      refusing = await peer(world, 'Refusing host', 'reject');
    await send(contested, syntheticSeedCommand());
    const resident = await raid(world, settled),
      loser = await raid(world, contested),
      refused = await raid(world, refusing);
    for (let i = 0; i < 2; i++) {
      await advance(settled, 3200);
      await observe(settled);
      await advance(settled, 800);
    }
    await advance(contested, 3200);
    await observe(contested);
    await advance(contested, 800);
    await advance(contested, 3200);
    await observe(contested);
    const rows = await updates(world, seed.lineageId);
    expect(rows.map((row) => row.sequence)).toEqual(rows.map((_, index) => index + 1));
    const of = (organism: string) =>
      rows.filter((row) => row.organism_id === organism).map((row) => [row.kind, row.channel_id]);
    expect(of(resident)).toEqual([
      ['born', world.channelId],
      ['admitted', settled.channelId],
      ['trace_earned', settled.channelId],
    ]);
    expect(of(loser)).toEqual([
      ['born', world.channelId],
      ['admitted', contested.channelId],
      ['fossilized', contested.channelId],
    ]);
    expect(of(refused)).toEqual([
      ['born', world.channelId],
      ['archived', null],
    ]);
    expect(of(seed.organismId)).toEqual([]);
    await expect(
      pool.query('update lineage_updates set kind=$3 where world_id=$1 and lineage_id=$2', [
        world.worldId,
        seed.lineageId,
        'born',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('delete from lineage_updates where world_id=$1 and lineage_id=$2', [
        world.worldId,
        seed.lineageId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });

    const digest = await returnSession(world);
    expect(digest?.items.map((item) => [item.kind, item.organismId])).toEqual([
      ['fossilized', loser],
      ['archived', refused],
      ['admitted', loser],
    ]);
    // Own-channel births are not news to the source; two further updates remain in the map.
    expect(digest?.remaining).toBe(2);
    expect(digest?.items[0]).toMatchObject({
      host: { channelId: contested.channelId, label: 'Synthetic Contested host' },
      generation: 1,
      lineageId: seed.lineageId,
    });
    expect(digest?.items[1]).toMatchObject({ host: null, traceTemplate: null });
    expect(JSON.stringify(digest)).not.toMatch(/private-|actorKey|twitch/i);
    expect(await returnSession(world)).toBeNull();
  });

  it('shows only news after a lineage was first met and leaves other channels unchanged', async () => {
    const { world, seed } = await start(),
      early = await peer(world, 'Early host', 'accept'),
      met = await peer(world, 'Meeting host', 'accept'),
      later = await peer(world, 'Later host', 'accept');
    await raid(world, early);
    const visitor = await raid(world, met);
    expect(await returnSession(met)).toBeNull();
    const afterMeeting = await raid(world, later);
    const digest = await returnSession(met);
    expect(digest?.items.map((item) => [item.kind, item.organismId, item.host?.label])).toEqual([
      ['admitted', afterMeeting, 'Synthetic Later host'],
      ['born', afterMeeting, expect.stringMatching(/^Synthetic/) as string],
    ]);
    expect(digest?.items.some((item) => item.organismId === visitor)).toBe(false);
    expect(digest?.remaining).toBe(0);
    const cursors = (
      await pool.query<{ channel_id: string; version: number }>(
        'select channel_id,version from descendant_cursors where world_id=$1 and lineage_id=$2',
        [world.worldId, seed.lineageId],
      )
    ).rows;
    expect(cursors).toEqual([
      { channel_id: met.channelId, version: (await updates(world, seed.lineageId)).length },
    ]);
    expect(
      (await readSnapshot(pool, world.worldId, early.channelId))!.payload.familyDigest,
    ).toBeNull();
  });
});
