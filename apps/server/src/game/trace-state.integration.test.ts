import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  candidateRuleset,
  generateMutationCandidates,
  sha256Hex,
  type RoundCheckpoint,
  type RoundResolution,
  type TraceTemplate,
} from '@ripple/engine';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { createSyntheticPeer } from './synthetic-peer.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { readSnapshot } from './snapshot.ts';
import { exportAcceptedChannel, verifyAcceptedRecords } from './replay.ts';
import type { TraceRow } from './trace-state.ts';

describe('earned habitat traces and recorded Keep/Clear decisions', () => {
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
  async function observe(world: SyntheticWorld, valid = true) {
    if (valid)
      for (const actorKey of ['a', 'b', 'c']) await send(world, { type: 'activity', actorKey });
    await advance(world, 12000);
  }
  async function snapshot(world: SyntheticWorld) {
    return (await readSnapshot(pool, world.worldId, world.channelId))!.payload;
  }
  async function traces(world: SyntheticWorld) {
    return (
      await pool.query<TraceRow>(
        'select * from habitat_traces where world_id=$1 and channel_id=$2 order by id',
        [world.worldId, world.channelId],
      )
    ).rows;
  }
  async function checkpoint(world: SyntheticWorld) {
    return (
      await pool.query<{ checkpoint: RoundCheckpoint; resolution: RoundResolution | null }>(
        'select checkpoint,resolution from rounds where world_id=$1 and channel_id=$2 order by number desc limit 1',
        [world.worldId, world.channelId],
      )
    ).rows[0]!;
  }
  function sourceInput(template: TraceTemplate) {
    const command = { ...syntheticSeedCommand(), roundId: '00000000-0000-4000-8000-000000000081' };
    if (template === 'charged') return { command, seed: 'charged-source', choice: null };
    const focus = template === 'shelter' ? 'grit' : 'calm';
    for (let i = 0; i < 100; i++) {
      const seed = `trace-${template}-${i}`,
        cards = generateMutationCandidates(
          { seed, roundId: command.roundId, genome: candidateRuleset.genome.founder },
          candidateRuleset,
        );
      const index = cards.findIndex((card) => card.move.to === focus);
      if (index >= 0) return { command, seed, choice: index + 1 };
    }
    throw new Error('Missing recorded trace-template scenario.');
  }
  function raid(target: string) {
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
  async function setup(template: TraceTemplate = 'charged', seedHost = false) {
    const input = sourceInput(template),
      source = await createSyntheticWorld(pool, { seed: input.seed, mechanicsVersion: 1 });
    await send(source, input.command);
    if (input.choice !== null) {
      await send(source, { type: 'vote', actorKey: 'template', choice: input.choice });
      await advance(source, 3200);
    }
    const peer = await createSyntheticPeer(
        pool,
        source,
        source.ownerCapability,
        randomUUID(),
        'Trace host',
      ),
      host = { ...source, channelId: peer.channelId };
    if (seedHost) await send(host, syntheticSeedCommand());
    await send(host, {
      type: 'policy',
      visitorPolicy: 'accept',
      expectedVersion: seedHost ? 1 : 0,
    });
    const incoming = raid(host.channelId);
    await send(source, incoming);
    if (seedHost) {
      await advance(host, 3200);
      await observe(host, false);
      await advance(host, 800);
    }
    expect((await snapshot(host)).round!.kind).toBe('WELCOME');
    return { source, host, incoming };
  }
  async function qualify(template: TraceTemplate = 'charged') {
    const fixture = await setup(template);
    await advance(fixture.host, 3200);
    await observe(fixture.host);
    expect(await traces(fixture.host)).toEqual([]);
    await advance(fixture.host, 800);
    await advance(fixture.host, 3200);
    await observe(fixture.host);
    expect(await traces(fixture.host)).toHaveLength(1);
    return fixture;
  }
  it('rolls back scoring, qualification and ancestry together on ledger failure, then qualifies exactly once', async () => {
    const { host } = await setup();
    await advance(host, 3200);
    await observe(host);
    await advance(host, 800);
    await advance(host, 3200);
    for (const actorKey of ['a', 'b', 'c']) await send(host, { type: 'activity', actorKey });
    const before = await snapshot(host),
      roundId = before.round!.id;
    await pool.query(`create function reject_trace_qualification() returns trigger language plpgsql as $$ begin raise exception 'qualification fault'; end $$;
      create trigger qualification_fault before insert on trace_qualifications for each row execute function reject_trace_qualification()`);
    try {
      await expect(advance(host, 12000)).rejects.toThrow('qualification fault');
      expect(await snapshot(host)).toEqual(before);
      expect(await traces(host)).toEqual([]);
      expect(
        (
          await pool.query('select 1 from ancestor_trials where world_id=$1 and round_id=$2', [
            host.worldId,
            roundId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query(
            'select completed_valid_rounds,trace_qualified from residencies where world_id=$1 and channel_id=$2 and ended_at is null',
            [host.worldId, host.channelId],
          )
        ).rows,
      ).toEqual([{ completed_valid_rounds: 1, trace_qualified: false }]);
    } finally {
      await pool.query(
        'drop trigger qualification_fault on trace_qualifications; drop function reject_trace_qualification()',
      );
    }
    await settleSyntheticWorld(pool, host);
    await settleSyntheticWorld(pool, host);
    expect(await traces(host)).toHaveLength(1);
    expect(
      (
        await pool.query('select 1 from trace_qualifications where world_id=$1 and channel_id=$2', [
          host.worldId,
          host.channelId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query('select 1 from ancestor_trials where world_id=$1 and round_id=$2', [
          host.worldId,
          roundId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          'select completed_valid_rounds,trace_qualified from residencies where world_id=$1 and channel_id=$2 and ended_at is null',
          [host.worldId, host.channelId],
        )
      ).rows,
    ).toEqual([{ completed_valid_rounds: 2, trace_qualified: true }]);
  });
  it.each<TraceTemplate>(['charged', 'shelter', 'recovery'])(
    'earns %s, keeps it with unchanged genes/slots and expires after exactly three valid observations',
    async (template) => {
      const { host, incoming } = await qualify(template),
        offer = (await traces(host))[0]!;
      expect(offer).toMatchObject({
        template,
        status: 'pending',
        remaining_rounds: 3,
        emitter_id: incoming.childId,
      });
      expect(offer.lifetime.countedRoundIds).toEqual([]);
      await send(host, { type: 'prepare' });
      await advance(host, 800);
      const voting = await snapshot(host);
      expect(voting.round!.kind).toBe('TRACE');
      expect(voting.round!.candidates.map((card) => card.id)).toEqual(['keep', 'clear']);
      const genes = async () =>
        (
          await pool.query<Record<string, unknown>>(
            'select pulse,calm,grit,drift,mutation_slots from organisms where world_id=$1 and id=$2',
            [host.worldId, incoming.childId],
          )
        ).rows[0];
      const before = await genes();
      await send(host, { type: 'vote', actorKey: 'first-valid', choice: 3 });
      expect(
        (
          await pool.query('select * from votes where world_id=$1 and round_id=$2', [
            host.worldId,
            voting.round!.id,
          ])
        ).rowCount,
      ).toBe(0);
      await send(host, { type: 'vote', actorKey: 'first-valid', choice: 1 });
      await advance(host, 3200);
      expect(await genes()).toEqual(before);
      expect((await traces(host))[0]).toMatchObject({
        status: 'active',
        remaining_rounds: 3,
        decision: { choice: 'keep', counts: [1, 0] },
      });
      await observe(host);
      expect((await checkpoint(host)).resolution).toMatchObject({
        outcome: 'applied',
        score: { trace: { template } },
      });
      expect((await traces(host))[0]!.remaining_rounds).toBe(2);
      const trial = (
        await pool.query<{ result: { current: { trace: unknown }; ancestor: { trace: unknown } } }>(
          'select a.result from ancestor_trials a join rounds r on r.world_id=a.world_id and r.id=a.round_id where a.world_id=$1 and r.id=$2',
          [host.worldId, voting.round!.id],
        )
      ).rows[0]!;
      expect(trial.result.current.trace).toMatchObject({ template });
      expect(trial.result.ancestor.trace).toMatchObject({ template });
      await advance(host, 800);
      expect((await snapshot(host)).round!.kind).toBe('PREPARATION');
      await advance(host, 3200);
      await observe(host);
      expect((await traces(host))[0]!.remaining_rounds).toBe(1);
      // The season ledger still prevents repeated eligibility even if a residency flag is lost.
      await pool.query(
        'update residencies set trace_qualified=false where world_id=$1 and organism_id=$2',
        [host.worldId, incoming.childId],
      );
      await advance(host, 800);
      expect((await snapshot(host)).round!.kind).toBe('MUTATION');
      await advance(host, 3200);
      await observe(host);
      expect(await traces(host)).toHaveLength(1);
      expect((await traces(host))[0]).toMatchObject({
        status: 'expired',
        remaining_rounds: 0,
        decision: { choice: 'keep', counts: [1, 0], terminal: { reason: 'valid-round-expiry' } },
      });
      expect(
        (
          await pool.query(
            'select * from trace_qualifications where world_id=$1 and channel_id=$2',
            [host.worldId, host.channelId],
          )
        ).rowCount,
      ).toBe(1);
      await expect(
        pool.query(
          "update habitat_traces set status='active',version=version+1 where world_id=$1 and id=$2",
          [host.worldId, offer.id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await advance(host, 800);
      expect((await checkpoint(host)).checkpoint.activeTrace).toBeNull();
      verifyAcceptedRecords(await exportAcceptedChannel(pool, host));
    },
  );
  it('defaults to Clear without fabricating votes or an active effect', async () => {
    const { host } = await qualify();
    await advance(host, 800);
    const before = (await snapshot(host)).organism!.health;
    await advance(host, 3200);
    expect((await traces(host))[0]).toMatchObject({
      status: 'cleared',
      remaining_rounds: 0,
      decision: { choice: 'clear', counts: [0, 0] },
    });
    expect((await snapshot(host)).organism!.health).toBe(before);
    expect((await checkpoint(host)).checkpoint.activeTrace).toBeNull();
    await observe(host);
    expect((await checkpoint(host)).resolution).toMatchObject({
      outcome: 'applied',
      score: { trace: null },
    });
  });
  it('replaces an active trace explicitly and activates an aged pending offer with one fresh allowance', async () => {
    const { host, source } = await qualify('shelter');
    await send(host, { type: 'pause', reason: 'manual' });
    const peerId = '00000000-0000-4000-8000-000000009001';
    const peer = await createSyntheticPeer(
        pool,
        source,
        source.ownerCapability,
        peerId,
        'Replacement emitter',
      ),
      sender = { ...source, channelId: peer.channelId };
    let seed = syntheticSeedCommand(),
      choice = 0;
    for (let i = 0; i < 100; i++) {
      seed = {
        ...seed,
        roundId: `00000000-0000-4000-8000-${(9100 + i).toString(16).padStart(12, '0')}`,
      };
      choice =
        generateMutationCandidates(
          {
            seed: sha256Hex(`synthetic-peer:${peerId}`),
            roundId: seed.roundId,
            genome: candidateRuleset.genome.founder,
          },
          candidateRuleset,
        ).findIndex((card) => card.move.to === 'pulse' && card.move.from !== 'grit') + 1;
      if (choice > 0) break;
    }
    expect(choice).toBeGreaterThan(0);
    await send(sender, seed);
    await send(sender, { type: 'vote', actorKey: 'burst-specialist', choice });
    await advance(sender, 3200);
    await observe(sender, false);
    const current = (await snapshot(sender)).organism!.genome;
    let nextRoundId = '',
      nextChoice = 0;
    for (let i = 0; i < 100; i++) {
      nextRoundId = `00000000-0000-4000-8000-${(9300 + i).toString(16).padStart(12, '0')}`;
      nextChoice =
        generateMutationCandidates(
          { seed: sha256Hex(`synthetic-peer:${peerId}`), roundId: nextRoundId, genome: current },
          candidateRuleset,
        ).findIndex((card) => card.move.to === 'pulse' && card.move.from !== 'grit') + 1;
      if (nextChoice > 0) break;
    }
    expect(nextChoice).toBeGreaterThan(0);
    await pool.query(
      "update deadlines set command=jsonb_set(command,'{nextRoundId}',to_jsonb($3::text)) where world_id=$1 and channel_id=$2 and status='pending' and command->>'type'='deadline'",
      [sender.worldId, sender.channelId, nextRoundId],
    );
    await advance(sender, 800);
    await send(sender, { type: 'vote', actorKey: 'burst-specialist-2', choice: nextChoice });
    await advance(sender, 3200);
    expect((await snapshot(sender)).organism!.genome).toMatchObject({ pulse: 10, grit: 6 });
    await send(sender, raid(host.channelId));
    await send(host, { type: 'resume' });
    await advance(host, 800);
    expect((await snapshot(host)).round!.kind).toBe('WELCOME');
    await advance(host, 3200);
    await observe(host);
    expect((await traces(host))[0]!.remaining_rounds).toBe(2);
    await advance(host, 800);
    expect((await snapshot(host)).round!.kind).toBe('TRACE');
    await send(host, { type: 'vote', actorKey: 'keep-old', choice: 1 });
    await advance(host, 3200);
    await observe(host);
    let offers = await traces(host),
      old = offers.find((row) => row.status === 'active')!,
      newOffer = offers.find((row) => row.status === 'pending')!;
    expect(old).toMatchObject({ template: 'shelter', remaining_rounds: 2 });
    expect(newOffer).toMatchObject({ template: 'charged', remaining_rounds: 3 });
    await advance(host, 800);
    expect((await snapshot(host)).round!.kind).toBe('MUTATION');
    await advance(host, 3200);
    await observe(host);
    offers = await traces(host);
    newOffer = offers.find((row) => row.status === 'pending')!;
    expect(newOffer.remaining_rounds).toBe(2);
    expect(newOffer.lifetime.countedRoundIds).toHaveLength(1);
    await advance(host, 800);
    expect((await snapshot(host)).round!.kind).toBe('TRACE');
    await send(host, { type: 'vote', actorKey: 'keep-new', choice: 1 });
    await advance(host, 3200);
    offers = await traces(host);
    old = offers.find((row) => row.id === old.id)!;
    newOffer = offers.find((row) => row.id === newOffer.id)!;
    expect(old).toMatchObject({
      status: 'replaced',
      remaining_rounds: 0,
      decision: { choice: 'keep', terminal: { reason: 'replaced', byTraceId: newOffer.id } },
    });
    expect(newOffer).toMatchObject({
      status: 'active',
      remaining_rounds: 3,
      lifetime: { countedRoundIds: [] },
    });
    expect(offers.filter((row) => row.status === 'active')).toHaveLength(1);
    await observe(host);
    expect((await traces(host)).find((row) => row.id === newOffer.id)!.remaining_rounds).toBe(2);
  });
  it('does not age through limited data, pause or interrupted observations and recovers into the same allowance', async () => {
    const { host } = await qualify();
    await advance(host, 800);
    await send(host, { type: 'vote', actorKey: 'keep', choice: 1 });
    await advance(host, 3200);
    await observe(host, false);
    expect((await traces(host))[0]!.remaining_rounds).toBe(3);
    await advance(host, 800);
    await send(host, { type: 'pause', reason: 'manual' });
    await advance(host, 300000);
    expect((await traces(host))[0]!.remaining_rounds).toBe(3);
    await send(host, { type: 'resume' });
    await advance(host, 3200);
    await send(host, { type: 'activity', actorKey: 'old-epoch' });
    await send(host, { type: 'interrupt', reason: 'input_outage' });
    await advance(host, 20000);
    expect((await traces(host))[0]!.remaining_rounds).toBe(3);
    await send(host, { type: 'integration', online: true, healthy: true });
    await send(host, { type: 'recover' });
    await observe(host);
    expect((await traces(host))[0]!.remaining_rounds).toBe(2);
  });
  it('expires a pending offer after three valid urgent welcomes without activating it', async () => {
    const { host, source } = await qualify();
    for (const remaining of [2, 1, 0]) {
      const peer = await createSyntheticPeer(
          pool,
          source,
          source.ownerCapability,
          randomUUID(),
          `Urgent welcome ${remaining}`,
        ),
        sender = { ...source, channelId: peer.channelId };
      await send(sender, syntheticSeedCommand());
      await send(sender, raid(host.channelId));
      await advance(host, 800);
      expect((await snapshot(host)).round!.kind).toBe('WELCOME');
      await advance(host, 3200);
      await observe(host);
      expect((await traces(host))[0]!.remaining_rounds).toBe(remaining);
    }
    expect((await traces(host))[0]).toMatchObject({
      status: 'expired',
      decision: { reason: 'awaiting-vote', terminal: { reason: 'valid-round-expiry' } },
    });
    expect((await checkpoint(host)).checkpoint.activeTrace).toBeNull();
  });
  it('ages one host allowance while applying the same active rule to resident and visitor', async () => {
    const { host, source } = await qualify('shelter');
    await advance(host, 800);
    await send(host, { type: 'vote', actorKey: 'keep', choice: 1 });
    await advance(host, 3200);
    await observe(host);
    const peer = await createSyntheticPeer(
        pool,
        source,
        source.ownerCapability,
        randomUUID(),
        'Shared trace entrant',
      ),
      sender = { ...source, channelId: peer.channelId };
    await send(sender, syntheticSeedCommand());
    await send(sender, raid(host.channelId));
    await advance(host, 800);
    await advance(host, 3200);
    await observe(host);
    const round = (await snapshot(host)).round!;
    const participants = (
      await pool.query<{ resolution: RoundResolution }>(
        'select resolution from round_participants where world_id=$1 and round_id=$2',
        [host.worldId, round.id],
      )
    ).rows;
    expect(participants).toHaveLength(2);
    for (const participant of participants)
      expect(participant.resolution).toMatchObject({
        outcome: 'applied',
        score: { trace: { template: 'shelter', amount: -1 } },
      });
    expect((await traces(host))[0]!.remaining_rounds).toBe(1);
  });
  it('does not emit from founder idle time or a visitor fossilized in its second valid contest', async () => {
    const { host, incoming } = await setup('charged', true);
    const welcome = (await snapshot(host)).round!,
      shelter = welcome.candidates.findIndex((card) => card.id === 'shelter') + 1;
    await send(host, { type: 'vote', actorKey: 'shelter-once', choice: shelter });
    await advance(host, 3200);
    await observe(host);
    await advance(host, 800);
    await advance(host, 3200);
    await observe(host);
    expect(
      (
        await pool.query('select status from organisms where world_id=$1 and id=$2', [
          host.worldId,
          incoming.childId,
        ])
      ).rows[0],
    ).toEqual({ status: 'FOSSIL' });
    expect(
      (
        await pool.query(
          'select completed_valid_rounds from residencies where world_id=$1 and organism_id=$2',
          [host.worldId, incoming.childId],
        )
      ).rows[0],
    ).toEqual({ completed_valid_rounds: 2 });
    expect(await traces(host)).toEqual([]);
    expect(
      (await pool.query('select * from trace_qualifications where world_id=$1', [host.worldId]))
        .rowCount,
    ).toBe(0);
  });
});
