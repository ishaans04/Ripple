import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  candidateRuleset,
  runAncestorTrial,
  type AncestorTrial,
  type ScoreInput,
} from '@ripple/engine';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { canonicalGameProjection, exportAcceptedChannel, replayAcceptedChannel } from './replay.ts';
import { createSyntheticPeer } from './synthetic-peer.ts';
import { readSnapshot } from './snapshot.ts';

describe('persisted matched founding-genome trials', () => {
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
  async function activity(world: SyntheticWorld) {
    for (const actorKey of ['a', 'b', 'c']) await send(world, { type: 'activity', actorKey });
  }
  async function trial(world: SyntheticWorld) {
    return (
      await pool.query<{
        organism_id: string;
        ancestor_id: string;
        matched_inputs: { scoreInput: ScoreInput; scoringStage: string };
        result: AncestorTrial;
      }>('select * from ancestor_trials where world_id=$1 order by round_id,organism_id', [
        world.worldId,
      ])
    ).rows;
  }
  it('has zero gameplay effect, captures matched shocks and replays the same analysis', async () => {
    const seed = syntheticSeedCommand(),
      worlds: SyntheticWorld[] = [];
    for (const mechanicsVersion of [0, 1] as const) {
      const world = await createSyntheticWorld(pool, {
        seed: 'trial-zero-effect',
        mechanicsVersion,
      });
      worlds.push(world);
      await send(world, seed);
      await send(world, { type: 'vote', actorKey: 'choose', choice: 2 });
      await advance(world, 3200);
      await send(world, { type: 'shock', kind: 'category_change' });
      await activity(world);
      await advance(world, 12000);
    }
    const legacy = worlds[0]!,
      source = worlds[1]!;
    const state = async (world: SyntheticWorld) =>
      (
        await pool.query<Record<string, unknown>>(
          'select pulse,calm,grit,drift,health,status,mutation_slots from organisms where world_id=$1',
          [world.worldId],
        )
      ).rows;
    expect(await state(source)).toEqual(await state(legacy));
    expect(await trial(legacy)).toEqual([]);
    const rows = await trial(source);
    expect(rows).toHaveLength(1);
    const saved = rows[0]!;
    expect(saved.matched_inputs.scoreInput).toMatchObject({
      healthBefore: 70,
      shocks: [{ kind: 'category_change' }],
      trace: null,
    });
    expect(saved.matched_inputs.scoringStage).toBe('before-shelter-settlement');
    expect(saved.result).toEqual(
      runAncestorTrial(
        saved.matched_inputs.scoreInput,
        candidateRuleset.genome.founder,
        candidateRuleset,
      ),
    );
    expect(
      (
        await pool.query('select count(*)::int as n from residencies where world_id=$1', [
          source.worldId,
        ])
      ).rows[0],
    ).toEqual({ n: 1 });
    await expect(
      pool.query("update ancestor_trials set result='{}' where world_id=$1", [source.worldId]),
    ).rejects.toMatchObject({ code: '23514' });
    const bundle = await exportAcceptedChannel(pool, source);
    const replay = await replayAcceptedChannel(pool, bundle);
    expect(await canonicalGameProjection(pool, replay)).toBe(
      await canonicalGameProjection(pool, source),
    );
    await expect(
      pool.query(
        `insert into ancestor_trials(world_id,round_id,organism_id,ancestor_id,matched_inputs,result,rules_hash)
      select world_id,round_id,organism_id,ancestor_id,'{}',result,rules_hash from ancestor_trials where world_id=$1`,
        [source.worldId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('creates no trial for limited or interrupted intervals and records one after explicit recovery', async () => {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(world, syntheticSeedCommand());
    await advance(world, 3200);
    await advance(world, 12000);
    expect(await trial(world)).toEqual([]);
    await advance(world, 800);
    await advance(world, 3200);
    await activity(world);
    await send(world, { type: 'interrupt', reason: 'input_outage' });
    await advance(world, 20000);
    expect(await trial(world)).toEqual([]);
    await send(world, { type: 'integration', online: true, healthy: true });
    await send(world, { type: 'recover' });
    await activity(world);
    await advance(world, 12000);
    expect(await trial(world)).toHaveLength(1);
  });
  it('uses the lineage founder rather than a child birth genome and captures arrival pressure once', async () => {
    const source = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    const seed = syntheticSeedCommand();
    await send(source, seed);
    await send(source, { type: 'vote', actorKey: 'mutate-parent', choice: 1 });
    await advance(source, 3200);
    const peer = await createSyntheticPeer(
      pool,
      source,
      source.ownerCapability,
      randomUUID(),
      'Trial host',
    );
    const target = { ...source, channelId: peer.channelId };
    await send(target, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    const childId = randomUUID();
    await send(source, {
      type: 'raid',
      transferId: randomUUID(),
      childId,
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: target.channelId,
      destinationTwitchId: target.channelId,
    });
    const snapshot = await readSnapshot(pool, target.worldId, target.channelId);
    const conserve =
      snapshot!.payload.round!.candidates.findIndex((card) => card.id === 'conserve') + 1;
    await send(target, { type: 'vote', actorKey: 'welcome', choice: conserve });
    await advance(target, 3200);
    await activity(target);
    await advance(target, 12000);
    const saved = (await trial(target)).find((row) => row.organism_id === childId)!;
    expect(saved.ancestor_id).toBe(seed.organismId);
    expect(saved.result.ancestor.genome).toEqual(candidateRuleset.genome.founder);
    expect(saved.result.current.genome).not.toEqual(saved.result.ancestor.genome);
    expect(saved.matched_inputs.scoreInput.shocks).toEqual([
      { kind: 'arrival', amount: candidateRuleset.shock.arrival },
    ]);
    expect(saved.result.current.healthBefore).toBe(saved.result.ancestor.healthBefore);
    expect(
      (
        await pool.query(
          'select arrival_pending from visitor_state where world_id=$1 and organism_id=$2',
          [source.worldId, childId],
        )
      ).rows[0],
    ).toEqual({ arrival_pending: false });
  });
  it('compares both real participants before the finite Shelter transfer settles', async () => {
    const source = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(source, syntheticSeedCommand());
    const peer = await createSyntheticPeer(
      pool,
      source,
      source.ownerCapability,
      randomUUID(),
      'Shelter trial',
    );
    const target = { ...source, channelId: peer.channelId },
      resident = syntheticSeedCommand();
    await send(target, resident);
    await send(target, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 1 });
    const childId = randomUUID();
    await send(source, {
      type: 'raid',
      transferId: randomUUID(),
      childId,
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: target.channelId,
      destinationTwitchId: target.channelId,
    });
    await advance(target, 3200);
    await advance(target, 12000);
    await advance(target, 800);
    const welcome = await readSnapshot(pool, target.worldId, target.channelId);
    expect(welcome!.payload.round!.kind).toBe('WELCOME');
    const shelter =
      welcome!.payload.round!.candidates.findIndex((card) => card.id === 'shelter') + 1;
    await send(target, { type: 'vote', actorKey: 'shelter', choice: shelter });
    await advance(target, 3200);
    await activity(target);
    await advance(target, 12000);
    const rows = await trial(target);
    const currentResident = rows.find((row) => row.organism_id === resident.organismId)!;
    const currentVisitor = rows.find((row) => row.organism_id === childId)!;
    expect(currentResident).toBeDefined();
    expect(currentVisitor).toBeDefined();
    const health = (
      await pool.query<{ id: string; health: number }>(
        'select id,health from organisms where world_id=$1',
        [source.worldId],
      )
    ).rows;
    expect(health.find((row) => row.id === resident.organismId)!.health).toBe(
      currentResident.result.current.healthAfter - 5,
    );
    expect(health.find((row) => row.id === childId)!.health).toBe(
      currentVisitor.result.current.healthAfter + 5,
    );
    expect(currentResident.result.current).toEqual(currentResident.result.ancestor);
    expect(currentVisitor.result.current).toEqual(currentVisitor.result.ancestor);
  });
  it('rolls gameplay and analysis back together on persistence failure, then retries once', async () => {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(world, syntheticSeedCommand());
    await advance(world, 3200);
    await activity(world);
    const before = await readSnapshot(pool, world.worldId, world.channelId);
    await pool.query(`create function inject_trial_failure() returns trigger language plpgsql as $$ begin raise exception 'injected trial persistence failure'; end; $$;
      create trigger inject_trial_failure before insert on ancestor_trials for each row execute function inject_trial_failure()`);
    try {
      await expect(advance(world, 12000)).rejects.toThrow('injected trial persistence failure');
      const after = await readSnapshot(pool, world.worldId, world.channelId);
      expect(after!.payload.organism).toEqual(before!.payload.organism);
      expect(after!.payload.round!.phase).toBe('OBSERVING');
      expect(after!.payload.round!.resolution).toBeNull();
      expect(await trial(world)).toEqual([]);
    } finally {
      await pool.query(
        'drop trigger inject_trial_failure on ancestor_trials; drop function inject_trial_failure()',
      );
    }
    await settleSyntheticWorld(pool, world);
    expect(await trial(world)).toHaveLength(1);
    await settleSyntheticWorld(pool, world);
    expect(await trial(world)).toHaveLength(1);
  });
});
