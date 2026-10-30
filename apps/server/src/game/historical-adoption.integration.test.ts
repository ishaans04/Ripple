import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, scanDeadlines } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import type { GameCommand } from '@ripple/contracts';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { createSyntheticPeer } from './synthetic-peer.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { processNextInput } from './worker.ts';
import { readSnapshot } from './snapshot.ts';
import { historicalOffers } from './historical-adoption.ts';
import type { TransferRow } from './propagation-store.ts';
import { exportAcceptedChannel, replayAcceptedChannel } from './replay.ts';

describe('retained raid invitations and historical adoption', () => {
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
  async function send(world: SyntheticWorld, channelId: string, command: GameCommand) {
    await acceptSyntheticCommand(
      pool,
      { worldId: world.worldId, channelId },
      world.ownerCapability,
      randomUUID(),
      command,
    );
    expect((await settleSyntheticWorld(pool, world)).pending).toBe(false);
  }
  async function transfer(world: SyntheticWorld, id: string) {
    return (
      await pool.query<TransferRow>('select * from transfers where world_id=$1 and id=$2', [
        world.worldId,
        id,
      ])
    ).rows[0]!;
  }
  async function setup(retain = true) {
    const world = await createSyntheticWorld(pool),
      target = randomUUID();
    await send(world, world.channelId, syntheticSeedCommand());
    const raid: Extract<GameCommand, { type: 'raid' }> = {
      type: 'raid',
      transferId: randomUUID(),
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: null,
      destinationTwitchId: target,
      ...(retain ? { retainUnenrolled: true } : {}),
    };
    await send(world, world.channelId, raid);
    return { world, target, raid, original: await transfer(world, raid.transferId) };
  }
  it('reserves a non-simulating snapshot, restricts invitations to the destination and adopts exactly once', async () => {
    const f = await setup();
    expect(f.original).toMatchObject({
      outcome: 'NOT_ENROLLED',
      child_id: f.raid.childId,
      destination_channel_id: null,
      claimed_at: null,
    });
    expect(
      (
        await pool.query('select 1 from residencies where world_id=$1 and organism_id=$2', [
          f.world.worldId,
          f.raid.childId,
        ])
      ).rowCount,
    ).toBe(0);
    await createSyntheticPeer(pool, f.world, f.world.ownerCapability, f.target, 'Receiver');
    const wrong = await createSyntheticPeer(
      pool,
      f.world,
      f.world.ownerCapability,
      randomUUID(),
      'Other',
    );
    expect(
      await historicalOffers(pool, f.world.worldId, wrong.channelId, f.raid.transferId),
    ).toEqual([]);
    expect(await historicalOffers(pool, f.world.worldId, f.target, f.raid.transferId)).toHaveLength(
      1,
    );
    await pool.query(
      'update organisms set pulse=8,calm=4,version=version+1 where world_id=$1 and id=$2',
      [f.world.worldId, f.original.parent_id],
    );
    await advanceSyntheticClock(pool, f.world, f.world.ownerCapability, randomUUID(), 1000);
    await Promise.all(
      [1, 2].map(() =>
        acceptSyntheticCommand(
          pool,
          { worldId: f.world.worldId, channelId: f.target },
          f.world.ownerCapability,
          randomUUID(),
          {
            type: 'claimRaid',
            transferId: f.raid.transferId,
            transferVersion: 0,
          },
        ),
      ),
    );
    await Promise.all([
      processNextInput(pool, f.world.worldId, f.target),
      processNextInput(pool, f.world.worldId, f.target),
    ]);
    await settleSyntheticWorld(pool, f.world);
    const adopted = await transfer(f.world, f.raid.transferId);
    expect(adopted).toMatchObject({ outcome: 'ACTIVE', destination_channel_id: f.target });
    expect(adopted.claimed_at!.getTime()).toBe(f.original.created_at.getTime() + 1000);
    expect(adopted.expires_at).toEqual(f.original.expires_at);
    expect(adopted.snapshot).toEqual(f.original.snapshot);
    const view = await readSnapshot(pool, f.world.worldId, f.target);
    expect(view?.payload.round?.kind).toBe('WELCOME');
    const incoming = view?.payload.propagation.admissions[0];
    expect(incoming?.historical).toBe(true);
    expect(Date.parse(incoming?.claimedAt ?? '')).toBe(adopted.claimed_at!.getTime());
    expect(
      (
        await pool.query(
          'select pulse,calm,health,status from organisms where world_id=$1 and id=$2',
          [f.world.worldId, f.raid.childId],
        )
      ).rows,
    ).toEqual([{ pulse: 6, calm: 6, health: 32, status: 'ALIVE' }]);
    expect(
      (await pool.query('select 1 from organisms where world_id=$1', [f.world.worldId])).rowCount,
    ).toBe(2);
    expect(
      (
        await pool.query<{ result: { code: string } }>(
          "select result from game_events where world_id=$1 and channel_id=$2 and command->>'type'='claimRaid' order by sequence",
          [f.world.worldId, f.target],
        )
      ).rows.map((r) => r.result.code),
    ).toEqual(['APPLIED', 'STALE_VERSION']);
    await expect(
      pool.query(
        "update transfers set claimed_at=claimed_at+interval '1 second' where world_id=$1 and id=$2",
        [f.world.worldId, f.raid.transferId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await historicalOffers(pool, f.world.worldId, f.target)).toEqual([]);
  });
  it('rejects forged destination identity and an expired request even when the caller supplies an earlier check time', async () => {
    const f = await setup();
    await createSyntheticPeer(pool, f.world, f.world.ownerCapability, f.target, 'Receiver');
    const wrong = await createSyntheticPeer(
      pool,
      f.world,
      f.world.ownerCapability,
      randomUUID(),
      'Other',
    );
    await send(f.world, wrong.channelId, {
      type: 'claimRaid',
      transferId: f.raid.transferId,
      transferVersion: 0,
      claimantTwitchId: f.target,
    });
    expect((await transfer(f.world, f.raid.transferId)).destination_channel_id).toBeNull();
    expect(
      (
        await pool.query<{ result: { code: string } }>(
          'select result from game_events where world_id=$1 and channel_id=$2 order by sequence desc limit 1',
          [f.world.worldId, wrong.channelId],
        )
      ).rows[0]!.result.code,
    ).toBe('NOT_CLAIM_DESTINATION');
    const otherWorld = await createSyntheticWorld(pool);
    await send(otherWorld, otherWorld.channelId, {
      type: 'claimRaid',
      transferId: f.raid.transferId,
      transferVersion: 0,
    });
    expect(
      (
        await pool.query<{ result: { code: string } }>(
          'select result from game_events where world_id=$1 and channel_id=$2 order by sequence desc limit 1',
          [otherWorld.worldId, otherWorld.channelId],
        )
      ).rows[0]!.result.code,
    ).toBe('CLAIM_NOT_AVAILABLE');
    await pool.query('update worlds set clock_at=$2 where id=$1', [
      f.world.worldId,
      f.original.expires_at,
    ]);
    await acceptSyntheticCommand(
      pool,
      { worldId: f.world.worldId, channelId: f.target },
      f.world.ownerCapability,
      randomUUID(),
      { type: 'claimRaid', transferId: f.raid.transferId, transferVersion: 0, checkedAtMs: 0 },
    );
    expect((await processNextInput(pool, f.world.worldId, f.target))?.effect.code).toBe(
      'CLAIM_EXPIRED',
    );
    await settleSyntheticWorld(pool, f.world);
    expect((await transfer(f.world, f.raid.transferId)).outcome).toBe('EXPIRED');
    expect(
      (
        await pool.query('select status from organisms where world_id=$1 and id=$2', [
          f.world.worldId,
          f.raid.childId,
        ])
      ).rows,
    ).toEqual([{ status: 'ARCHIVED' }]);
  });
  it('expires an unclaimed child while its source is paused and never creates destination state', async () => {
    const f = await setup();
    await send(f.world, f.world.channelId, { type: 'pause', reason: 'manual' });
    await pool.query('update worlds set clock_at=$2 where id=$1', [
      f.world.worldId,
      f.original.expires_at,
    ]);
    expect(await scanDeadlines(pool, randomUUID(), { worldId: f.world.worldId })).toBe(1);
    await settleSyntheticWorld(pool, f.world);
    expect((await transfer(f.world, f.raid.transferId)).outcome).toBe('EXPIRED');
    expect(
      (
        await pool.query('select health,status from organisms where world_id=$1 and id=$2', [
          f.world.worldId,
          f.raid.childId,
        ])
      ).rows,
    ).toEqual([{ health: 32, status: 'ARCHIVED' }]);
    expect(
      (
        await pool.query('select 1 from channels where world_id=$1 and id=$2', [
          f.world.worldId,
          f.target,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await scanDeadlines(pool, randomUUID(), { worldId: f.world.worldId })).toBe(0);
  });
  it('rolls back binding and expiry relocation together, then recovers the accepted request into an offline hold', async () => {
    const f = await setup();
    await createSyntheticPeer(pool, f.world, f.world.ownerCapability, f.target, 'Receiver');
    await send(f.world, f.target, { type: 'stream', online: false });
    await acceptSyntheticCommand(
      pool,
      { worldId: f.world.worldId, channelId: f.target },
      f.world.ownerCapability,
      randomUUID(),
      { type: 'claimRaid', transferId: f.raid.transferId, transferVersion: 0 },
    );
    await pool.query(
      "create function pg_temp.reject_claim_expiry() returns trigger language plpgsql as $$ begin if new.job_key like 'admission-expiry:%' then raise exception 'injected historical expiry failure'; end if; return new; end; $$",
    );
    await pool.query(
      'create trigger reject_claim_expiry before insert on deadlines for each row execute function pg_temp.reject_claim_expiry()',
    );
    try {
      await expect(processNextInput(pool, f.world.worldId, f.target)).rejects.toThrow(
        'injected historical expiry failure',
      );
    } finally {
      await pool.query('drop trigger reject_claim_expiry on deadlines');
    }
    expect(await transfer(f.world, f.raid.transferId)).toMatchObject({
      destination_channel_id: null,
      claimed_at: null,
      version: 0,
    });
    expect(
      (
        await pool.query(
          'select channel_id,status from deadlines where world_id=$1 and job_key=$2',
          [f.world.worldId, `admission-expiry:${f.raid.transferId}`],
        )
      ).rows,
    ).toEqual([{ channel_id: f.world.channelId, status: 'pending' }]);
    await settleSyntheticWorld(pool, f.world);
    const held = await transfer(f.world, f.raid.transferId);
    expect(held).toMatchObject({ outcome: 'OFFLINE_HOLD', destination_channel_id: f.target });
    expect(held.expires_at).toEqual(f.original.expires_at);
    expect(
      (
        await pool.query(
          "select channel_id,due_at from deadlines where world_id=$1 and job_key=$2 and status='pending'",
          [f.world.worldId, `admission-expiry:${f.raid.transferId}`],
        )
      ).rows,
    ).toEqual([{ channel_id: f.target, due_at: f.original.expires_at }]);
  });
  it('keeps the three-entry harbor cap during historical claims without evicting an earlier hold', async () => {
    const world = await createSyntheticWorld(pool),
      target = randomUUID(),
      sources = [world.channelId];
    for (let i = 0; i < 3; i++)
      sources.push(
        (await createSyntheticPeer(pool, world, world.ownerCapability, randomUUID(), `Source ${i}`))
          .channelId,
      );
    const ids: string[] = [];
    for (const source of sources) {
      await send(world, source, syntheticSeedCommand());
      const id = randomUUID();
      ids.push(id);
      await send(world, source, {
        type: 'raid',
        transferId: id,
        childId: randomUUID(),
        residencyId: randomUUID(),
        arrivalRoundId: randomUUID(),
        destinationChannelId: null,
        destinationTwitchId: target,
        retainUnenrolled: true,
      });
    }
    await createSyntheticPeer(pool, world, world.ownerCapability, target, 'Receiver');
    await send(world, target, { type: 'stream', online: false });
    for (const id of ids)
      await send(world, target, { type: 'claimRaid', transferId: id, transferVersion: 0 });
    expect(
      (await readSnapshot(pool, world.worldId, target))?.payload.propagation.admissions.map(
        (t) => t.id,
      ),
    ).toEqual(ids.slice(0, 3));
    expect((await transfer(world, ids[3]!)).outcome).toBe('NOT_ENROLLED');
    expect(
      (
        await pool.query<{ result: { code: string } }>(
          'select result from game_events where world_id=$1 and channel_id=$2 order by sequence desc limit 1',
          [world.worldId, target],
        )
      ).rows[0]!.result.code,
    ).toBe('CLAIM_CAPACITY');
  });
  it('replays older non-retaining raids and new retained raids without changing their accepted checksums', async () => {
    for (const retain of [false, true]) {
      const f = await setup(retain),
        bundle = await exportAcceptedChannel(pool, f.world);
      const replay = await replayAcceptedChannel(pool, bundle);
      const rebuilt = (
        await pool.query<TransferRow>('select * from transfers where world_id=$1 and id=$2', [
          replay.worldId,
          f.raid.transferId,
        ])
      ).rows[0]!;
      expect(rebuilt.snapshot).toEqual(f.original.snapshot);
      expect(rebuilt.child_id).toBe(retain ? f.raid.childId : null);
      if (!retain)
        expect(bundle.records.find((r) => r.command.type === 'raid')?.command).not.toHaveProperty(
          'retainUnenrolled',
        );
    }
  });
});
