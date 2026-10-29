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
import { createSyntheticPeer } from './synthetic-peer.ts';
import { canonicalGameProjection, exportAcceptedChannel, replayAcceptedChannel } from './replay.ts';
import type { DormantRow } from './dormant-state.ts';
import type { TransferRow } from './propagation-store.ts';
import { readSnapshot } from './snapshot.ts';

describe('atomic dormant inheritance across raids and historical invitations', () => {
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
  async function send(world: SyntheticWorld, value: unknown, receipt = randomUUID()) {
    const accepted = await acceptSyntheticCommand(
      pool,
      world,
      world.ownerCapability,
      receipt,
      value,
    );
    await settleSyntheticWorld(pool, world);
    return accepted;
  }
  async function advance(world: SyntheticWorld, ms: number) {
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), ms);
  }
  async function observe(world: SyntheticWorld) {
    await advance(world, 800);
    await advance(world, 3200);
    for (const actorKey of ['a', 'b', 'c']) await send(world, { type: 'activity', actorKey });
    await advance(world, 12000);
  }
  async function dormant(world: SyntheticWorld, organismId: string) {
    return (
      await pool.query<{ value: DormantRow }>(
        "select to_jsonb(d)-'world_id' as value from dormant_mutations d where world_id=$1 and organism_id=$2",
        [world.worldId, organismId],
      )
    ).rows[0]!.value;
  }
  async function start() {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 1 }),
      seed = syntheticSeedCommand();
    await send(world, seed);
    for (let i = 0; i < 5; i++)
      await send(world, { type: 'vote', actorKey: `capture-${i}`, choice: i < 3 ? 1 : 2 });
    await advance(world, 3200);
    for (const actorKey of ['a', 'b', 'c']) await send(world, { type: 'activity', actorKey });
    await advance(world, 12000);
    await observe(world);
    const parent = await dormant(world, seed.organismId);
    expect(parent.remaining_rounds).toBe(2);
    return { world, seed, parent };
  }
  function raid(target: string | null, twitch = target ?? randomUUID()) {
    return {
      type: 'raid',
      transferId: randomUUID(),
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: target,
      destinationTwitchId: twitch,
      retainUnenrolled: true,
    };
  }
  async function transfer(world: SyntheticWorld, id: string) {
    return (
      await pool.query<TransferRow>('select * from transfers where world_id=$1 and id=$2', [
        world.worldId,
        id,
      ])
    ).rows[0]!;
  }
  it('consumes inherited allowance during valid legacy-host observations without enabling capture, offers or scoring changes', async () => {
    const { world, parent } = await start(),
      channelId = randomUUID(),
      host = { ...world, channelId };
    await pool.query(
      `insert into channels(world_id,id,label,rules_hash,seed,configuration,online,healthy,initial_online,initial_healthy)
      select world_id,$3,'Legacy dormant host',rules_hash,seed,configuration,true,true,true,true from channels where world_id=$1 and id=$2`,
      [world.worldId, world.channelId, channelId],
    );
    await send(host, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    const command = raid(channelId);
    await send(world, command);
    expect((await dormant(world, command.childId)).remaining_rounds).toBe(parent.remaining_rounds);
    expect(parent.remaining_rounds).toBe(2);
    await advance(host, 3200);
    await advance(host, 12000);
    expect((await dormant(world, command.childId)).remaining_rounds).toBe(2);
    for (const remaining of [1, 0]) {
      await advance(host, 800);
      await advance(host, 3200);
      for (const actorKey of ['a', 'b', 'c']) await send(host, { type: 'activity', actorKey });
      await advance(host, 12000);
      expect((await dormant(world, command.childId)).remaining_rounds).toBe(remaining);
      const snapshot = (await readSnapshot(pool, world.worldId, channelId))!.payload;
      expect(snapshot.mechanics.version).toBe(0);
      expect(snapshot.round!.choicePreview).toBeUndefined();
      expect(snapshot.round!.analysis!.mechanicsVersion).toBe(0);
      expect(snapshot.round!.analysis!.participants[0]!.ancestor).toBeNull();
    }
    expect(
      (
        await pool.query(
          'select status from dormant_mutations where world_id=$1 and organism_id=$2',
          [world.worldId, command.childId],
        )
      ).rows,
    ).toEqual([{ status: 'expired' }]);
    await send(host, { type: 'enableMechanics' });
    await advance(host, 800);
    expect((await readSnapshot(pool, world.worldId, channelId))!.payload.mechanics).toMatchObject({
      version: 1,
      state: { dormant: [] },
    });
    expect((await dormant(world, command.childId)).remaining_rounds).toBe(0);
  });
  it('preserves the remaining allowance and counted IDs in an inert child despite later parent activity and receipt retry', async () => {
    const { world, seed, parent } = await start();
    const peer = await createSyntheticPeer(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      'Dormant harbor',
    );
    await send(
      { ...world, channelId: peer.channelId },
      { type: 'integration', online: false, healthy: true },
    );
    const command = raid(peer.channelId),
      receipt = randomUUID();
    await send(world, command, receipt);
    const child = await dormant(world, command.childId),
      original = await transfer(world, command.transferId);
    expect(child.lifetime).toEqual(parent.lifetime);
    expect(child.remaining_rounds).toBe(2);
    expect(child.remaining_hops).toBe(parent.remaining_hops - 1);
    expect(child.offered).toBe(parent.offered);
    expect(child.provenance).toMatchObject({
      ...parent.provenance,
      inheritedFrom: {
        organismId: seed.organismId,
        dormantId: parent.id,
        version: parent.version,
        transferId: command.transferId,
      },
    });
    expect(original.snapshot.dormant).toMatchObject({
      sourceId: parent.id,
      sourceVersion: parent.version,
      lifetime: parent.lifetime,
    });
    await observe(world);
    expect((await dormant(world, seed.organismId)).remaining_rounds).toBe(1);
    expect(await dormant(world, command.childId)).toEqual(child);
    expect((await transfer(world, command.transferId)).snapshot).toEqual(original.snapshot);
    expect((await send(world, command, receipt)).duplicate).toBe(true);
    expect(
      (
        await pool.query('select * from dormant_mutations where world_id=$1 and organism_id=$2', [
          world.worldId,
          command.childId,
        ])
      ).rowCount,
    ).toBe(1);
    await expect(
      pool.query(
        `insert into dormant_mutations(world_id,id,organism_id,source_round_id,template,provenance,remaining_hops,remaining_rounds,status,lifetime,offered)
      select world_id,$3,organism_id,source_round_id,template,provenance,remaining_hops,3,'active',jsonb_set(lifetime,'{remainingRounds}','3'),offered from dormant_mutations where world_id=$1 and id=$2`,
        [world.worldId, child.id, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('reconstructs retained inheritance and does not renew it when the destination later enrolls and claims', async () => {
    const { world, parent } = await start(),
      target = randomUUID(),
      command = raid(null, target);
    await send(world, command);
    const child = await dormant(world, command.childId),
      original = await transfer(world, command.transferId);
    expect(child.lifetime).toEqual(parent.lifetime);
    expect(
      (
        await pool.query('select * from residencies where world_id=$1 and organism_id=$2', [
          world.worldId,
          command.childId,
        ])
      ).rowCount,
    ).toBe(0);
    await observe(world);
    const replay = await replayAcceptedChannel(pool, await exportAcceptedChannel(pool, world));
    expect(await canonicalGameProjection(pool, replay)).toBe(
      await canonicalGameProjection(pool, world),
    );
    expect(await dormant({ ...world, worldId: replay.worldId }, command.childId)).toEqual(child);
    await createSyntheticPeer(
      pool,
      world,
      world.ownerCapability,
      target,
      'Historical dormant host',
    );
    await send(
      { ...world, channelId: target },
      { type: 'integration', online: false, healthy: true },
    );
    await send(
      { ...world, channelId: target },
      { type: 'claimRaid', transferId: command.transferId, transferVersion: 0 },
    );
    expect((await transfer(world, command.transferId)).destination_channel_id).toBe(target);
    expect((await transfer(world, command.transferId)).expires_at).toEqual(original.expires_at);
    expect(await dormant(world, command.childId)).toEqual(child);
  });
  it('rolls back child, inherited state and transfer together on copy failure, then retries the accepted raid once', async () => {
    const { world } = await start(),
      command = raid(null);
    await pool.query(`create function inject_inheritance_failure() returns trigger language plpgsql as $$ begin if NEW.provenance ? 'inheritedFrom' then raise exception 'injected inheritance failure'; end if; return NEW; end; $$;
      create trigger inject_inheritance_failure before insert on dormant_mutations for each row execute function inject_inheritance_failure()`);
    try {
      await expect(send(world, command)).rejects.toThrow('injected inheritance failure');
      expect(
        (
          await pool.query('select * from organisms where world_id=$1 and id=$2', [
            world.worldId,
            command.childId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query('select * from transfers where world_id=$1 and id=$2', [
            world.worldId,
            command.transferId,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await pool.query(
        'drop trigger inject_inheritance_failure on dormant_mutations; drop function inject_inheritance_failure()',
      );
    }
    await settleSyntheticWorld(pool, world);
    expect(await dormant(world, command.childId)).toBeDefined();
    expect(
      (
        await pool.query('select * from transfers where world_id=$1 and id=$2', [
          world.worldId,
          command.transferId,
        ])
      ).rowCount,
    ).toBe(1);
  });
});
