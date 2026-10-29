import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { candidateRuleset, replayRejectedChoices, type AlternativeReplay } from '@ripple/engine';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { canonicalGameProjection, exportAcceptedChannel, replayAcceptedChannel } from './replay.ts';

describe('recorded rejected-choice comparisons', () => {
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
  async function start() {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(world, syntheticSeedCommand());
    return world;
  }
  async function comparisons(world: SyntheticWorld) {
    return (
      await pool.query<{
        inputs: Parameters<typeof replayRejectedChoices>[0] & {
          actualOutcome: string;
          actualHealthAfter: number;
        };
        result: AlternativeReplay;
        confidence: string;
      }>('select * from choice_replays where world_id=$1 order by round_id', [world.worldId])
    ).rows;
  }
  it('persists the two rejected cards under actual observed inputs and reconstructs them without changing gameplay', async () => {
    const world = await start();
    await send(world, { type: 'vote', actorKey: 'winner', choice: 2 });
    await advance(world, 3200);
    await send(world, { type: 'shock', kind: 'category_change' });
    for (const actorKey of ['a', 'b', 'c']) await send(world, { type: 'activity', actorKey });
    await advance(world, 12000);
    const saved = (await comparisons(world))[0]!;
    expect(saved.confidence).toBe('confident');
    expect(saved.result.rejected).toHaveLength(2);
    expect(saved.result).toEqual(replayRejectedChoices(saved.inputs, candidateRuleset));
    expect(saved.inputs.actualOutcome).toBe('applied');
    expect(saved.inputs.actualHealthAfter).toBe(saved.result.actual.healthAfter);
    expect(
      saved.result.rejected.every((card) => card.candidateId !== saved.inputs.selectedId),
    ).toBe(true);
    await expect(
      pool.query("update choice_replays set result='{}' where world_id=$1", [world.worldId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into choice_replays select world_id,round_id,organism_id,rules_hash,engine_version,confidence,'{}',result from choice_replays where world_id=$1`,
        [world.worldId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const before = await canonicalGameProjection(pool, world);
    const replay = await replayAcceptedChannel(pool, await exportAcceptedChannel(pool, world));
    expect(await canonicalGameProjection(pool, replay)).toBe(before);
    expect(await canonicalGameProjection(pool, world)).toBe(before);
  });
  it('labels limited-data Hold comparisons as estimates while preserving actual energy', async () => {
    const world = await start();
    await advance(world, 3200);
    await advance(world, 12000);
    const rows = await comparisons(world);
    expect(rows).toHaveLength(1);
    const saved = rows[0]!;
    expect(saved.confidence).toBe('limited');
    expect(saved.inputs.selectedId).toBeNull();
    expect(saved.inputs.actualOutcome).toBe('limited');
    expect(saved.inputs.actualHealthAfter).toBe(70);
    expect(saved.result.rejected).toHaveLength(3);
    expect(saved.result.actual.healthAfter).not.toBe(70);
    expect(
      (await pool.query('select health from organisms where world_id=$1', [world.worldId])).rows[0],
    ).toEqual({ health: 70 });
    expect(
      (await pool.query('select * from ancestor_trials where world_id=$1', [world.worldId]))
        .rowCount,
    ).toBe(0);
  });
  it('does not fabricate mutation comparisons for a preparation ballot or interrupted observation', async () => {
    const world = await start();
    await send(world, { type: 'prepare' });
    await advance(world, 3200);
    await send(world, { type: 'interrupt', reason: 'input_outage' });
    expect(await comparisons(world)).toEqual([]);
    await send(world, { type: 'integration', online: true, healthy: true });
    await send(world, { type: 'recover' });
    await advance(world, 12000);
    expect(await comparisons(world)).toHaveLength(1);
    await advance(world, 800);
    await advance(world, 3200);
    await advance(world, 12000);
    expect(await comparisons(world)).toHaveLength(1);
  });
});
