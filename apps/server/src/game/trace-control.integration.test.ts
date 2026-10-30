import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import type { GameCommand } from '@ripple/contracts';
import type { RoundCheckpoint, RoundResolution } from '@ripple/engine';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { createSyntheticPeer } from './synthetic-peer.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { readSnapshot } from './snapshot.ts';
import type { TraceRow } from './trace-state.ts';

describe('recorded broadcaster trace controls', () => {
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
    return accepted;
  }
  async function advance(world: SyntheticWorld, ms: number) {
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), ms);
  }
  async function observe(world: SyntheticWorld) {
    for (const actorKey of ['a', 'b', 'c']) await send(world, { type: 'activity', actorKey });
    await advance(world, 12000);
  }
  async function trace(world: SyntheticWorld) {
    return (
      await pool.query<TraceRow>(
        'select * from habitat_traces where world_id=$1 and channel_id=$2',
        [world.worldId, world.channelId],
      )
    ).rows[0]!;
  }
  async function snapshot(world: SyntheticWorld) {
    return (await readSnapshot(pool, world.worldId, world.channelId))!;
  }
  async function savedRound(world: SyntheticWorld, id: string) {
    return (
      await pool.query<{
        phase: string;
        checkpoint: RoundCheckpoint;
        completed_at: Date | null;
        resolution: RoundResolution | null;
      }>('select * from rounds where world_id=$1 and id=$2', [world.worldId, id])
    ).rows[0]!;
  }
  async function qualify(disabled = false) {
    const source = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(source, syntheticSeedCommand());
    const peer = await createSyntheticPeer(
        pool,
        source,
        source.ownerCapability,
        randomUUID(),
        'Controlled trace host',
      ),
      host = { ...source, channelId: peer.channelId };
    await send(host, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    if (disabled) await send(host, { type: 'setTraces', enabled: false });
    await send(source, {
      type: 'raid',
      transferId: randomUUID(),
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: host.channelId,
      destinationTwitchId: host.channelId,
    });
    await advance(host, 3200);
    await observe(host);
    await advance(host, 800);
    await advance(host, 3200);
    await observe(host);
    expect(await trace(host)).toBeDefined();
    return host;
  }
  async function active() {
    const host = await qualify();
    await advance(host, 800);
    await send(host, { type: 'vote', actorKey: 'keep', choice: 1 });
    await advance(host, 3200);
    return host;
  }
  it('rolls back trace clearing, round cancellation and deadlines together before retrying the accepted command once', async () => {
    const host = await qualify();
    await advance(host, 800);
    await send(host, { type: 'vote', actorKey: 'accepted-before-failure', choice: 1 });
    const before = await snapshot(host),
      roundId = before.payload.round!.id,
      savedTrace = await trace(host);
    const deadlines = (
      await pool.query(
        'select id,status,command from deadlines where world_id=$1 and channel_id=$2 order by id',
        [host.worldId, host.channelId],
      )
    ).rows;
    await pool.query(`create function reject_trace_cancellation() returns trigger language plpgsql as $$ begin
      if NEW.checkpoint ? 'traceDecisionCancelled' then raise exception 'cancellation fault'; end if; return NEW; end $$;
      create trigger cancellation_fault before update on rounds for each row execute function reject_trace_cancellation()`);
    try {
      await expect(send(host, { type: 'clearTrace' })).rejects.toThrow('cancellation fault');
      expect((await snapshot(host)).payload).toEqual(before.payload);
      expect(await trace(host)).toEqual(savedTrace);
      expect(
        (
          await pool.query(
            'select id,status,command from deadlines where world_id=$1 and channel_id=$2 order by id',
            [host.worldId, host.channelId],
          )
        ).rows,
      ).toEqual(deadlines);
    } finally {
      await pool.query(
        'drop trigger cancellation_fault on rounds; drop function reject_trace_cancellation()',
      );
    }
    await settleSyntheticWorld(pool, host);
    await settleSyntheticWorld(pool, host);
    expect((await savedRound(host, roundId)).checkpoint.traceDecisionCancelled).toMatchObject({
      reason: 'broadcaster-clear',
    });
    expect((await savedRound(host, roundId)).resolution).toBeNull();
    expect((await trace(host)).status).toBe('cleared');
    expect(
      (
        await pool.query('select 1 from votes where world_id=$1 and round_id=$2', [
          host.worldId,
          roundId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "select 1 from game_events where world_id=$1 and channel_id=$2 and command->>'type'='clearTrace'",
          [host.worldId, host.channelId],
        )
      ).rowCount,
    ).toBe(1);
    expect((await snapshot(host)).payload.round!.kind).toBe('MUTATION');
  }, 20000);
  it('cancels a pending trace ballot explicitly and fences its obsolete cutoff without inventing a result', async () => {
    const host = await qualify();
    await advance(host, 800);
    await send(host, { type: 'vote', actorKey: 'accepted-before-clear', choice: 1 });
    const before = await snapshot(host),
      id = before.payload.round!.id;
    const obsolete = (
      await pool.query<{ command: GameCommand }>(
        "select command from deadlines where world_id=$1 and channel_id=$2 and status='pending' and command->>'type'='deadline'",
        [host.worldId, host.channelId],
      )
    ).rows[0]!.command;
    await send(host, { type: 'clearTrace', expectedVersion: before.version });
    const cancelled = await savedRound(host, id);
    expect(cancelled).toMatchObject({
      phase: 'COMPLETE',
      resolution: null,
      checkpoint: {
        clock: { phase: 'COMPLETE', deadlineAtMs: null },
        traceDecisionCancelled: { reason: 'broadcaster-clear' },
      },
    });
    expect(cancelled.completed_at).not.toBeNull();
    expect(await trace(host)).toMatchObject({
      status: 'cleared',
      decision: { terminal: { reason: 'broadcaster-clear' } },
    });
    expect((await trace(host)).decision.choice).toBeUndefined();
    expect(
      (
        await pool.query('select * from votes where world_id=$1 and round_id=$2', [
          host.worldId,
          id,
        ])
      ).rowCount,
    ).toBe(1);
    const after = await snapshot(host);
    expect(after.payload.round!.kind).toBe('MUTATION');
    expect(after.payload.round!.id).not.toBe(id);
    expect(after.payload.organism).toEqual(before.payload.organism);
    const at = (
      await pool.query<{ clock_at: Date }>('select clock_at from worlds where id=$1', [
        host.worldId,
      ])
    ).rows[0]!.clock_at.getTime();
    await acceptInput(pool, {
      worldId: host.worldId,
      channelId: host.channelId,
      provider: 'late-cutoff-fixture',
      messageId: randomUUID(),
      command: obsolete,
      requiredMode: 'sandbox',
      acceptedAtMs: at,
    });
    await settleSyntheticWorld(pool, host);
    expect((await snapshot(host)).payload.round).toEqual(after.payload.round);
  }, 20000);
  it('removes an observing modifier before scoring while retaining the actual Keep decision', async () => {
    const host = await active(),
      before = await snapshot(host),
      id = before.payload.round!.id;
    await send(host, { type: 'clearTrace', expectedVersion: before.version });
    expect((await savedRound(host, id)).checkpoint).toMatchObject({
      activeTrace: null,
      traceCleared: { reason: 'broadcaster-clear' },
    });
    expect(await trace(host)).toMatchObject({
      status: 'cleared',
      decision: { choice: 'keep', counts: [1, 0], terminal: { reason: 'broadcaster-clear' } },
    });
    await observe(host);
    expect((await savedRound(host, id)).resolution).toMatchObject({
      outcome: 'applied',
      score: { trace: null },
    });
    const repeated = await send(host, { type: 'clearTrace' });
    expect(
      (
        await pool.query<{ result: { code: string } }>(
          'select result from game_events where world_id=$1 and channel_id=$2 and sequence=$3',
          [host.worldId, host.channelId, repeated.sequence],
        )
      ).rows[0]!.result.code,
    ).toBe('NO_CHANGE');
  }, 20000);
  it.each([false, true])(
    'clears future effects without rewriting resolved scores, including interrupted reveal=%s',
    async (interrupted) => {
      const host = await active();
      await observe(host);
      if (interrupted) await send(host, { type: 'interrupt', reason: 'input_outage' });
      const before = await snapshot(host),
        id = before.payload.round!.id,
        round = await savedRound(host, id);
      const trial = (
        await pool.query<Record<string, unknown>>(
          'select * from ancestor_trials where world_id=$1 and round_id=$2',
          [host.worldId, id],
        )
      ).rows;
      await send(host, { type: 'clearTrace' });
      expect(await savedRound(host, id)).toEqual(round);
      expect(
        (
          await pool.query<Record<string, unknown>>(
            'select * from ancestor_trials where world_id=$1 and round_id=$2',
            [host.worldId, id],
          )
        ).rows,
      ).toEqual(trial);
      if (interrupted) {
        await send(host, { type: 'integration', online: true, healthy: true });
        await send(host, { type: 'recover' });
      }
      await advance(host, 800);
      expect(
        (await savedRound(host, (await snapshot(host)).payload.round!.id)).checkpoint.activeTrace,
      ).toBeNull();
    },
    20000,
  );
  it('records disabled qualification once and never revives it by toggling the preference', async () => {
    const host = await qualify(true),
      rejected = await trace(host);
    expect(rejected).toMatchObject({
      status: 'rejected',
      remaining_rounds: 0,
      decision: { reason: 'traces-disabled' },
    });
    expect((await snapshot(host)).payload.mechanics.tracesEnabled).toBe(false);
    await send(host, { type: 'setTraces', enabled: true });
    await advance(host, 800);
    expect((await snapshot(host)).payload.round!.kind).toBe('MUTATION');
    await advance(host, 3200);
    await observe(host);
    expect(await trace(host)).toEqual(rejected);
    expect(
      (
        await pool.query('select * from trace_qualifications where world_id=$1 and channel_id=$2', [
          host.worldId,
          host.channelId,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await snapshot(host)).payload.mechanics.tracesEnabled).toBe(true);
  });
  it('cancels a held trace ballot on disable and starts a new ballot only after explicit resume', async () => {
    const host = await qualify();
    await advance(host, 800);
    const id = (await snapshot(host)).payload.round!.id;
    await send(host, { type: 'pause', reason: 'manual' });
    await send(host, { type: 'setTraces', enabled: false });
    expect((await savedRound(host, id)).checkpoint.traceDecisionCancelled).toMatchObject({
      reason: 'traces-disabled',
    });
    expect(
      (
        await pool.query(
          'select * from rounds where world_id=$1 and channel_id=$2 and completed_at is null',
          [host.worldId, host.channelId],
        )
      ).rowCount,
    ).toBe(0);
    await send(host, { type: 'setTraces', enabled: true });
    await send(host, { type: 'resume' });
    expect((await snapshot(host)).payload.round!.kind).toBe('MUTATION');
    expect((await trace(host)).status).toBe('cleared');
  });
});
