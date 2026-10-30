import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, runMigrations, scanDeadlines } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { propagationViewSchema, type GameCommand } from '@ripple/contracts';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { processNextInput, type WorkerReceipt } from './worker.ts';
import { readSnapshot } from './snapshot.ts';
import type { TransferRow } from './propagation-store.ts';

describe('persisted preparation, welcome and shared visitor observations', () => {
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
  async function drain(world: SyntheticWorld): Promise<WorkerReceipt[]> {
    const results: WorkerReceipt[] = [];
    for (let pass = 0; pass < 200; pass++) {
      const channels = await pool.query<{ id: string }>(
        'select id from channels where world_id=$1 and processed_sequence<intake_sequence order by id',
        [world.worldId],
      );
      if (channels.rowCount === 0) return results;
      for (const c of channels.rows) {
        const result = await processNextInput(pool, world.worldId, c.id);
        if (result !== null) results.push(result);
      }
    }
    throw new Error('World input did not settle');
  }
  async function send(
    world: SyntheticWorld,
    channelId: string,
    command: GameCommand,
  ): Promise<WorkerReceipt[]> {
    await acceptSyntheticCommand(
      pool,
      { worldId: world.worldId, channelId },
      world.ownerCapability,
      randomUUID(),
      command,
    );
    return drain(world);
  }
  async function snapshot(world: SyntheticWorld, channelId = world.channelId) {
    const result = await readSnapshot(pool, world.worldId, channelId);
    if (result === null) throw new Error('Missing synthetic channel');
    expect(propagationViewSchema.safeParse(result.payload.propagation).success).toBe(true);
    return result;
  }
  async function peer(world: SyntheticWorld, seed = true) {
    const channelId = randomUUID();
    await pool.query(
      `insert into channels(world_id,id,label,rules_hash,seed,configuration,online,healthy,initial_online,initial_healthy) select world_id,$3,'Synthetic receiver',rules_hash,$4,configuration,true,true,true,true from channels where world_id=$1 and id=$2`,
      [world.worldId, world.channelId, channelId, 'receiver-seed'],
    );
    if (seed) await send(world, channelId, syntheticSeedCommand());
    return channelId;
  }
  async function start() {
    const world = await createSyntheticWorld(pool);
    await send(world, world.channelId, syntheticSeedCommand());
    return world;
  }
  async function cutoff(world: SyntheticWorld, channelId = world.channelId) {
    const job = (
      await pool.query<{ due_at: Date }>(
        "select due_at from deadlines where world_id=$1 and channel_id=$2 and command->>'type'='deadline' and status='pending' order by due_at limit 1",
        [world.worldId, channelId],
      )
    ).rows[0];
    if (job === undefined) throw new Error('Missing round cutoff');
    await pool.query('update worlds set clock_at=greatest(clock_at,$2) where id=$1', [
      world.worldId,
      job.due_at,
    ]);
    await scanDeadlines(pool);
    return drain(world);
  }
  async function round(world: SyntheticWorld, channelId = world.channelId) {
    await cutoff(world, channelId);
    await cutoff(world, channelId);
    await cutoff(world, channelId);
  }
  async function acceptVisitors(world: SyntheticWorld, target: string) {
    const current = await snapshot(world, target);
    await send(world, target, {
      type: 'policy',
      visitorPolicy: 'accept',
      expectedVersion: current.version,
    });
  }
  function raidCommand(target: string): Extract<GameCommand, { type: 'raid' }> {
    return {
      type: 'raid',
      transferId: randomUUID(),
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: target,
      destinationTwitchId: target,
    };
  }
  it('repeatedly races duplicate raids against round close without forking an uncommitted genome', async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const world = await start(),
        target = await peer(world, false);
      const before = await snapshot(world);
      const candidate = before.payload.round?.candidates[0];
      if (!candidate || !('genome' in candidate)) throw new Error('Missing genetic candidate');
      await send(world, world.channelId, { type: 'vote', actorKey: 'race-voter', choice: 1 });
      const job = (
        await pool.query<{ command: unknown; due_at: Date }>(
          "select command,due_at from deadlines where world_id=$1 and channel_id=$2 and status='pending' order by due_at limit 1",
          [world.worldId, world.channelId],
        )
      ).rows[0]!;
      const raid = raidCommand(target),
        messageId = randomUUID();
      const enqueueRaid = () =>
        acceptSyntheticCommand(pool, world, world.ownerCapability, messageId, raid);
      const enqueueClose = () =>
        acceptInput(pool, {
          worldId: world.worldId,
          channelId: world.channelId,
          provider: 'release-close-race',
          messageId: 'close',
          command: job.command,
          acceptedAtMs: job.due_at.getTime(),
        });
      await Promise.all(
        (attempt % 2 ? [enqueueRaid, enqueueClose] : [enqueueClose, enqueueRaid]).map((fn) => fn()),
      );
      await enqueueRaid();
      await Promise.all([
        processNextInput(pool, world.worldId, world.channelId),
        processNextInput(pool, world.worldId, world.channelId),
      ]);
      await drain(world);
      const events = (
        await pool.query<{ sequence: number; type: string }>(
          "select sequence,command->>'type' type from game_events where world_id=$1 and channel_id=$2 and command->>'type' in ('raid','deadline') order by sequence",
          [world.worldId, world.channelId],
        )
      ).rows;
      expect(events).toHaveLength(2);
      const transfer = (
        await pool.query<TransferRow>('select * from transfers where world_id=$1', [world.worldId])
      ).rows;
      expect(transfer).toHaveLength(1);
      const parentGenome =
        events[0]?.type === 'raid' ? before.payload.organism?.genome : candidate.genome;
      expect(transfer[0]?.snapshot.parent?.genome).toEqual(parentGenome);
      const children = await pool.query(
        'select id from organisms where world_id=$1 and parent_id is not null',
        [world.worldId],
      );
      expect(children.rowCount).toBe(1);
      expect(await processNextInput(pool, world.worldId, world.channelId)).toBeNull();
    }
  });
  it('coalesces preparation at the next boundary, commits standing Shield, and never adds a mutation slot', async () => {
    const world = await start();
    expect((await send(world, world.channelId, { type: 'prepare' }))[0]?.effect.code).toBe(
      'APPLIED',
    );
    expect((await send(world, world.channelId, { type: 'prepare' }))[0]?.effect.code).toBe(
      'NO_CHANGE',
    );
    expect((await snapshot(world)).payload.round?.kind).toBe('MUTATION');
    await round(world);
    const prepared = await snapshot(world);
    expect(prepared.payload.round?.kind).toBe('PREPARATION');
    const slotsBefore = (
      await pool.query<{ mutation_slots: unknown }>(
        'select mutation_slots from organisms where world_id=$1',
        [world.worldId],
      )
    ).rows[0]!.mutation_slots;
    const shield = prepared.payload.round!.candidates.findIndex((c) => c.id === 'shield') + 1;
    await send(world, world.channelId, {
      type: 'vote',
      actorKey: 'preparation-voter',
      choice: shield,
    });
    await cutoff(world);
    expect(
      (
        await pool.query<{ preparation: string }>(
          'select preparation from channel_play where world_id=$1 and channel_id=$2',
          [world.worldId, world.channelId],
        )
      ).rows[0]?.preparation,
    ).toBe('shield');
    expect((await snapshot(world)).payload.organism?.genome).toEqual({
      pulse: 6,
      calm: 6,
      grit: 6,
      drift: 6,
    });
    const slots = (
      await pool.query<{ mutation_slots: { next: number } }>(
        'select mutation_slots from organisms where world_id=$1',
        [world.worldId],
      )
    ).rows[0]!.mutation_slots;
    expect(slots).toEqual(slotsBefore);
    const target = await peer(world, false);
    await acceptVisitors(world, target);
    const cmd = raidCommand(target);
    await send(world, world.channelId, cmd);
    const transfer = (
      await pool.query<TransferRow>('select * from transfers where world_id=$1 and id=$2', [
        world.worldId,
        cmd.transferId,
      ])
    ).rows[0]!;
    expect(transfer.snapshot.preparation).toBe('shield');
    expect(transfer.snapshot.arrival).toEqual({ health: 28, spent: 4, shockReduction: 2 });
    const incoming = await snapshot(world, target);
    expect(incoming.payload.round?.kind).toBe('WELCOME');
    expect(incoming.payload.round?.candidates).toHaveLength(2);
  });
  it('keeps an open ballot unchanged, holds Shelter through limited data, then compares matched fitness once', async () => {
    const world = await start(),
      target = await peer(world);
    await acceptVisitors(world, target);
    const before = await snapshot(world, target),
      parent = (await snapshot(world)).payload.organism!;
    const cmd = raidCommand(target);
    await send(world, world.channelId, cmd);
    expect((await snapshot(world, target)).payload.round?.id).toBe(before.payload.round?.id);
    expect((await snapshot(world, target)).payload.round?.candidates).toEqual(
      before.payload.round?.candidates,
    );
    await round(world, target);
    let current = await snapshot(world, target);
    expect(current.payload.round?.kind).toBe('WELCOME');
    const shelter = current.payload.round!.candidates.findIndex((c) => c.id === 'shelter') + 1;
    expect(shelter).toBeGreaterThan(0);
    await send(world, target, { type: 'vote', actorKey: 'welcome-voter', choice: shelter });
    await cutoff(world, target);
    await cutoff(world, target);
    expect(
      (
        await pool.query<{ shelter_pending: boolean; arrival_pending: boolean }>(
          'select shelter_pending,arrival_pending from visitor_state where world_id=$1',
          [world.worldId],
        )
      ).rows,
    ).toEqual([{ shelter_pending: true, arrival_pending: true }]);
    await cutoff(world, target);
    await cutoff(world, target);
    for (const actorKey of ['alice', 'bob', 'carol'])
      await send(world, target, { type: 'activity', actorKey });
    const resolution = await cutoff(world, target);
    const compared = resolution.find((r) => r.effect.updateType === 'contest.resolved');
    expect(compared?.effect.detail.visitor).toMatchObject({
      contest: { outcome: 'sheltered', moved: 5, shelterPending: false },
    });
    expect(
      (
        await pool.query<{ shelter_pending: boolean; arrival_pending: boolean }>(
          'select shelter_pending,arrival_pending from visitor_state where world_id=$1',
          [world.worldId],
        )
      ).rows,
    ).toEqual([{ shelter_pending: false, arrival_pending: false }]);
    await cutoff(world, target);
    await cutoff(world, target);
    for (const actorKey of ['alice', 'bob', 'carol'])
      await send(world, target, { type: 'activity', actorKey });
    await cutoff(world, target);
    const transfer = (
      await pool.query<TransferRow>('select * from transfers where world_id=$1 and id=$2', [
        world.worldId,
        cmd.transferId,
      ])
    ).rows[0]!;
    expect(transfer.outcome).toBe('VISITOR_LOST');
    current = await snapshot(world, target);
    expect(current.payload.propagation.visitor).toBeNull();
    expect(current.payload.propagation.lastContest).toMatchObject({
      visitorId: cmd.childId,
      outcome: 'resident',
      moved: 0,
    });
    expect(current.payload.organism?.id).toBe(before.payload.organism?.id);
    expect(
      (
        await pool.query<{ status: string }>(
          'select status from organisms where world_id=$1 and id=$2',
          [world.worldId, cmd.childId],
        )
      ).rows[0]?.status,
    ).toBe('FOSSIL');
    expect((await snapshot(world)).payload.organism?.id).toBe(parent.id);
    expect(
      (
        await pool.query(
          'select 1 from round_participants where world_id=$1 and organism_id=$2 and resolution is not null',
          [world.worldId, cmd.childId],
        )
      ).rowCount,
    ).toBe(3);
  });
  it('keeps three FIFO harbor entries, rejects overflow and promotes the oldest after an explicit decline', async () => {
    const world = await start(),
      target = await peer(world);
    await acceptVisitors(world, target);
    const sources = [world.channelId];
    for (let n = 0; n < 4; n++) sources.push(await peer(world));
    const raids = sources.map(() => raidCommand(target));
    for (const [index, source] of sources.entries()) await send(world, source, raids[index]!);
    const rows = (
      await pool.query<TransferRow>(
        'select * from transfers where world_id=$1 order by destination_sequence nulls last,created_at,id',
        [world.worldId],
      )
    ).rows;
    expect(rows.filter((r) => r.outcome === 'ACTIVE')).toHaveLength(1);
    expect(rows.filter((r) => r.outcome === 'HARBOR')).toHaveLength(3);
    expect(rows.filter((r) => r.outcome === 'HARBOR_FULL')).toHaveLength(1);
    expect(rows.find((r) => r.outcome === 'HARBOR_FULL')?.child_id).toBeNull();
    const projected = (await snapshot(world, target)).payload.propagation;
    expect(projected.admissions).toHaveLength(4);
    expect(projected.visitor?.id).toBe(raids[0]?.childId);
    expect(projected.limits).toMatchObject({ harborCap: 3, livingLineageCap: 12 });
    expect(projected.admissions.map((t) => t.id)).toEqual(
      raids.slice(0, 4).map((t) => t.transferId),
    );
    const sourceProjection = (await snapshot(world)).payload.propagation;
    expect(sourceProjection.resident?.livingBranches).toBe(2);
    expect(sourceProjection.outgoing).toHaveLength(1);
    expect(sourceProjection.outgoing[0]?.sourceChannelId).toBe(world.channelId);
    expect(JSON.stringify(projected)).not.toMatch(/actorKey|encrypted_tokens|csrf|access_token/);
    const active = rows.find((r) => r.outcome === 'ACTIVE')!,
      firstWaiting = rows.find((r) => r.outcome === 'HARBOR')!;
    await send(world, target, {
      type: 'admission',
      transferId: active.id,
      transferVersion: active.version,
      decision: 'decline',
      roundId: randomUUID(),
    });
    expect(
      (
        await pool.query<{ organism_id: string }>(
          "select organism_id from residencies where world_id=$1 and channel_id=$2 and role='visitor' and ended_at is null",
          [world.worldId, target],
        )
      ).rows,
    ).toEqual([{ organism_id: firstWaiting.child_id }]);
    expect(
      (
        await pool.query<{ status: string }>(
          'select status from organisms where world_id=$1 and id=$2',
          [world.worldId, active.child_id],
        )
      ).rows[0]?.status,
    ).toBe('ARCHIVED');
    expect(
      (
        await pool.query(
          "select 1 from deadlines where world_id=$1 and channel_id=$2 and job_key like 'admission-expiry:%' and status='pending'",
          [world.worldId, target],
        )
      ).rowCount,
    ).toBe(2);
  });
  it('serializes a twelve-branch lineage cap across distinct reproducing parents and counts held descendants', async () => {
    const world = await start(),
      parentHost = await peer(world, false);
    await acceptVisitors(world, parentHost);
    const first = raidCommand(parentHost);
    await send(world, world.channelId, first);
    await cutoff(world, parentHost);
    expect((await snapshot(world, parentHost)).payload.organism?.id).toBe(first.childId);
    const targets: string[] = [];
    for (let n = 0; n < 12; n++) {
      const target = await peer(world, false);
      await acceptVisitors(world, target);
      targets.push(target);
    }
    const commands = targets.map(raidCommand);
    await Promise.all(
      commands.map((command, index) =>
        acceptSyntheticCommand(
          pool,
          { worldId: world.worldId, channelId: index % 2 === 0 ? world.channelId : parentHost },
          world.ownerCapability,
          randomUUID(),
          command,
        ),
      ),
    );
    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        processNextInput(pool, world.worldId, index % 2 === 0 ? world.channelId : parentHost),
      ),
    );
    await drain(world);
    const founder = (
      await pool.query<{ lineage_id: string }>(
        'select lineage_id from organisms where world_id=$1 and id=$2',
        [world.worldId, first.childId],
      )
    ).rows[0]!.lineage_id;
    expect(
      (
        await pool.query(
          "select 1 from organisms where world_id=$1 and lineage_id=$2 and status in ('ALIVE','HARBOR')",
          [world.worldId, founder],
        )
      ).rowCount,
    ).toBe(12);
    expect(
      (
        await pool.query("select 1 from transfers where world_id=$1 and outcome='LINEAGE_CAP'", [
          world.worldId,
        ])
      ).rowCount,
    ).toBe(2);
    expect(
      (
        await pool.query('select 1 from organisms where world_id=$1 and parent_id=$2', [
          world.worldId,
          first.childId,
        ])
      ).rowCount,
    ).toBeGreaterThan(0);
  });
  it('archives blocked pending lineages and sources while offline, without evicting active visitors', async () => {
    const world = await start(),
      target = await peer(world),
      secondSource = await peer(world);
    const first = raidCommand(target);
    await send(world, world.channelId, first);
    const lineageId = (
      await pool.query<{ lineage_id: string }>(
        'select lineage_id from organisms where world_id=$1 and id=$2',
        [world.worldId, first.childId],
      )
    ).rows[0]!.lineage_id;
    await send(world, target, { type: 'stream', online: false });
    await send(world, target, { type: 'blockLineage', lineageId, blocked: true });
    const readTransfer = async (id: string) =>
      (
        await pool.query<TransferRow>('select * from transfers where world_id=$1 and id=$2', [
          world.worldId,
          id,
        ])
      ).rows[0]!;
    expect((await readTransfer(first.transferId)).outcome).toBe('LINEAGE_BLOCKED');
    expect((await snapshot(world)).payload.organism?.status).toBe('ALIVE');
    expect(
      (await send(world, target, { type: 'blockLineage', lineageId, blocked: true }))[0]?.effect
        .code,
    ).toBe('NO_CHANGE');
    await send(world, target, { type: 'blockLineage', lineageId, blocked: false });
    expect((await readTransfer(first.transferId)).outcome).toBe('LINEAGE_BLOCKED');
    const next = raidCommand(target);
    await send(world, secondSource, next);
    expect((await readTransfer(next.transferId)).outcome).toBe('OFFLINE_HOLD');
    await send(world, target, {
      type: 'blockSource',
      sourceChannelId: secondSource,
      blocked: true,
    });
    expect((await readTransfer(next.transferId)).outcome).toBe('SOURCE_BLOCKED');
    await send(world, target, { type: 'stream', online: true });
    await acceptVisitors(world, target);
    const thirdSource = await peer(world),
      active = raidCommand(target);
    await send(world, thirdSource, active);
    expect((await readTransfer(active.transferId)).outcome).toBe('ACTIVE');
    await send(world, target, { type: 'blockSource', sourceChannelId: thirdSource, blocked: true });
    expect((await readTransfer(active.transferId)).outcome).toBe('ACTIVE');
    // Existing visitors need the explicit decline control; blocking affects admission.
    await send(world, target, {
      type: 'admission',
      transferId: active.transferId,
      transferVersion: (await readTransfer(active.transferId)).version,
      decision: 'decline',
      roundId: randomUUID(),
    });
    expect((await readTransfer(active.transferId)).outcome).toBe('DECLINED');
    const other = await start(),
      foreign = (
        await pool.query<{ lineage_id: string }>(
          'select lineage_id from organisms where world_id=$1',
          [other.worldId],
        )
      ).rows[0]!.lineage_id;
    expect(
      (await send(world, target, { type: 'blockLineage', lineageId: foreign, blocked: true }))[0]
        ?.effect.code,
    ).toBe('NO_CHANGE');
    await expect(
      pool.query('insert into lineage_blocks(world_id,channel_id,lineage_id) values($1,$2,$3)', [
        world.worldId,
        target,
        foreign,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('serializes reciprocal raids with sorted locks and retains both original residents', async () => {
    const world = await start(),
      peerId = await peer(world);
    await acceptVisitors(world, world.channelId);
    await acceptVisitors(world, peerId);
    const residents = [
      (await snapshot(world)).payload.organism?.id,
      (await snapshot(world, peerId)).payload.organism?.id,
    ];
    const raids = [raidCommand(peerId.toUpperCase()), raidCommand(world.channelId.toUpperCase())];
    await Promise.all(
      [world.channelId, peerId].map((channelId, i) =>
        acceptSyntheticCommand(
          pool,
          { worldId: world.worldId, channelId },
          world.ownerCapability,
          randomUUID(),
          raids[i],
        ),
      ),
    );
    await Promise.all(
      [world.channelId, peerId].map((channelId) =>
        processNextInput(pool, world.worldId, channelId),
      ),
    );
    await drain(world);
    const views = await Promise.all([snapshot(world), snapshot(world, peerId)]);
    expect(views.map((v) => v.payload.organism?.id)).toEqual(residents);
    expect(views.map((v) => v.payload.propagation.visitor?.id)).toEqual([
      raids[1]!.childId,
      raids[0]!.childId,
    ]);
    expect(
      (await pool.query('select 1 from transfers where world_id=$1', [world.worldId])).rowCount,
    ).toBe(2);
    expect(
      (
        await pool.query("select 1 from organisms where world_id=$1 and status='ALIVE'", [
          world.worldId,
        ])
      ).rowCount,
    ).toBe(4);
  });
  it('dispatches pending-admission expiry while both channel clocks are paused and never revives the archived child', async () => {
    const world = await start(),
      target = await peer(world, false),
      raid = raidCommand(target);
    await send(world, target, { type: 'stream', online: false });
    await send(world, world.channelId, raid);
    await send(world, world.channelId, { type: 'pause', reason: 'manual' });
    const transfer = (
      await pool.query<TransferRow>('select * from transfers where world_id=$1 and id=$2', [
        world.worldId,
        raid.transferId,
      ])
    ).rows[0]!;
    expect(transfer.outcome).toBe('OFFLINE_HOLD');
    await pool.query('update worlds set clock_at=$2 where id=$1', [
      world.worldId,
      transfer.expires_at,
    ]);
    expect(await scanDeadlines(pool, randomUUID(), { worldId: world.worldId })).toBe(1);
    await drain(world);
    const child = (
      await pool.query<{ status: string; health: number }>(
        'select status,health from organisms where world_id=$1 and id=$2',
        [world.worldId, raid.childId],
      )
    ).rows[0]!;
    expect(child).toEqual({ status: 'ARCHIVED', health: transfer.snapshot.arrival?.health });
    await send(world, target, { type: 'stream', online: true });
    await acceptVisitors(world, target);
    expect((await snapshot(world, target)).payload.propagation.visitor).toBeNull();
    expect(
      (
        await pool.query<{ outcome: string }>(
          'select outcome from transfers where world_id=$1 and id=$2',
          [world.worldId, raid.transferId],
        )
      ).rows[0]?.outcome,
    ).toBe('EXPIRED');
    expect(await scanDeadlines(pool, randomUUID(), { worldId: world.worldId })).toBe(0);
  });
});
