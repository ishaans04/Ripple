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
import type { GameCommand } from '@ripple/contracts';
import { acceptSyntheticCommand, createSyntheticWorld, syntheticSeedCommand } from './sandbox.ts';
import { createSyntheticPeer } from './synthetic-peer.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { readSnapshot } from './snapshot.ts';

describe('bounded synthetic peers and world-wide clock', () => {
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
  it('creates one peer and its scoped read capability under concurrent retry and enforces world ownership', async () => {
    const world = await createSyntheticWorld(pool),
      id = randomUUID();
    const replies = await Promise.all([
      createSyntheticPeer(pool, world, world.ownerCapability, id, 'B'),
      createSyntheticPeer(pool, world, world.ownerCapability, id, 'B'),
    ]);
    expect(replies.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(replies[0].readCapability).toBe(replies[1].readCapability);
    expect(
      (
        await pool.query(
          'select 1 from overlay_capabilities where world_id=$1 and channel_id=$2 and hash=$3',
          [world.worldId, id, sha256Hex(replies[0].readCapability)],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      createSyntheticPeer(pool, world, world.readCapability, randomUUID(), 'C'),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      createSyntheticPeer(pool, world, world.ownerCapability, id, 'Different'),
    ).rejects.toThrow('different channel');
    await expect(
      createSyntheticPeer(pool, world, world.ownerCapability, world.channelId, 'channel'),
    ).rejects.toThrow('different channel');
    const live = await createTestChannel(pool, 'live'),
      owner = 'fixture-owner';
    await pool.query('update worlds set owner_capability_hash=$2 where id=$1', [
      live.worldId,
      sha256Hex(owner),
    ]);
    await expect(
      createSyntheticPeer(pool, live, owner, randomUUID(), 'Forbidden'),
    ).rejects.toMatchObject({ code: 'WRONG_WORLD_MODE' });
  });
  it('caps an owner world at eight channels even when distinct peer requests compete', async () => {
    const world = await createSyntheticWorld(pool);
    const replies = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        createSyntheticPeer(pool, world, world.ownerCapability, randomUUID(), `Peer ${i}`),
      ),
    );
    expect(replies.filter((r) => r.status === 'fulfilled')).toHaveLength(7);
    for (const reply of replies)
      if (reply.status === 'rejected')
        expect(reply.reason).toMatchObject({ code: 'CAPACITY_FULL' });
    expect(
      (await pool.query('select 1 from channels where world_id=$1', [world.worldId])).rowCount,
    ).toBe(8);
  });
  it('drains raid delivery and all peer cutoffs while leaving another world unchanged', async () => {
    const world = await createSyntheticWorld(pool),
      other = await createSyntheticWorld(pool);
    const peer = await createSyntheticPeer(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      'Receiver',
    );
    async function send(channelId: string, command: GameCommand) {
      await acceptSyntheticCommand(
        pool,
        { worldId: world.worldId, channelId },
        world.ownerCapability,
        randomUUID(),
        command,
      );
      expect((await settleSyntheticWorld(pool, world)).pending).toBe(false);
    }
    await send(world.channelId, syntheticSeedCommand());
    await acceptSyntheticCommand(
      pool,
      other,
      other.ownerCapability,
      randomUUID(),
      syntheticSeedCommand(),
    );
    await settleSyntheticWorld(pool, other);
    // An unrelated world also has a due cutoff. Advancing this world must not dispatch it.
    await pool.query(
      "update worlds set clock_at=clock_at+interval '3200 milliseconds' where id=$1",
      [other.worldId],
    );
    const untouched = await readSnapshot(pool, other.worldId, other.channelId);
    await send(peer.channelId, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    const raid: Extract<GameCommand, { type: 'raid' }> = {
      type: 'raid',
      transferId: randomUUID(),
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: peer.channelId,
      destinationTwitchId: peer.channelId,
    };
    await send(world.channelId, raid);
    expect((await readSnapshot(pool, world.worldId, peer.channelId))?.payload.round?.kind).toBe(
      'WELCOME',
    );
    const advance = await advanceSyntheticClock(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      3200,
    );
    expect(advance.pending).toBe(false);
    for (const id of [world.channelId, peer.channelId])
      expect((await readSnapshot(pool, world.worldId, id))?.payload.round?.phase).toBe('OBSERVING');
    for (const actorKey of ['alice', 'bob', 'carol'])
      await send(peer.channelId, { type: 'activity', actorKey });
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), 12000);
    const received = await readSnapshot(pool, world.worldId, peer.channelId);
    expect(received?.payload.organism?.id).toBe(raid.childId);
    expect(received?.payload.round?.resolution?.outcome).toBe('applied');
    expect((await readSnapshot(pool, other.worldId, other.channelId))?.payload).toEqual(
      untouched?.payload,
    );
    expect(
      (
        await pool.query(
          "select 1 from deadlines where world_id=$1 and status='pending' and due_at<=(select clock_at from worlds where id=$1)",
          [other.worldId],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))?.payload.organism?.status,
    ).toBe('ALIVE');
  });
});
