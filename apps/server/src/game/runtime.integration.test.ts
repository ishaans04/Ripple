import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { liveRoundTimings } from '@ripple/contracts';
import { acceptInput, releaseRuntimeLease, runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { candidateRuleset, rulesetCanonicalJson, rulesetHash } from '@ripple/engine';
import { runGameCycle } from './runtime.ts';
import { acceptSyntheticCommand, syntheticSeedCommand } from './sandbox.ts';
import { createJudgeWorld } from '../routes/sandbox.ts';
import { readSnapshot } from './snapshot.ts';
import { processNextInput } from './worker.ts';

describe('process-gap recovery', () => {
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
  async function live(): Promise<{ worldId: string; channelId: string }> {
    const worldId = randomUUID(),
      channelId = randomUUID(),
      rules = candidateRuleset,
      hash = rulesetHash(rules);
    await pool.query(
      'insert into rulesets (hash,version,engine_version,canonical) values ($1,$2,1,$3) on conflict do nothing',
      [hash, rules.version, rulesetCanonicalJson(rules)],
    );
    await pool.query(`insert into worlds (id,mode,rules_hash) values ($1,'live',$2)`, [
      worldId,
      hash,
    ]);
    await pool.query(
      `insert into channels (world_id,id,label,rules_hash,seed,configuration,online,healthy) values ($1,$2,'Synthetic live-mode integration fixture',$3,'fixed',$4,true,true)`,
      [worldId, channelId, hash, JSON.stringify(liveRoundTimings)],
    );
    await acceptInput(pool, {
      worldId,
      channelId,
      provider: 'test',
      messageId: 'seed',
      command: syntheticSeedCommand(),
    });
    await processNextInput(pool, worldId, channelId);
    return { worldId, channelId };
  }
  it('records an interruption before dispatching overdue work on ownership takeover', async () => {
    const scope = await live(),
      owner = randomUUID(),
      logger = { error: vi.fn() };
    await runGameCycle(pool, owner, logger);
    const snapshot = await readSnapshot(pool, scope.worldId, scope.channelId);
    expect(snapshot?.payload).toMatchObject({
      healthy: false,
      organism: { health: 70 },
      round: { phase: 'INTERRUPTED' },
    });
    await runGameCycle(pool, owner, logger);
    expect(
      (await pool.query('select * from game_events where world_id=$1', [scope.worldId])).rowCount,
    ).toBe(2);
    expect(logger.error).not.toHaveBeenCalled();
    await releaseRuntimeLease(pool, owner);
  });
  it('preserves a clean shutdown checkpoint instead of discarding known observation time', async () => {
    const scope = await live(),
      owner = randomUUID(),
      logger = { error: vi.fn() };
    await acceptInput(pool, {
      ...scope,
      provider: 'test',
      messageId: 'pause',
      command: { type: 'pause', reason: 'shutdown' },
    });
    await processNextInput(pool, scope.worldId, scope.channelId);
    const before = await readSnapshot(pool, scope.worldId, scope.channelId);
    await runGameCycle(pool, owner, logger);
    const after = await readSnapshot(pool, scope.worldId, scope.channelId);
    expect(after?.payload.round?.clock).toEqual(before?.payload.round?.clock);
    expect(after?.payload.healthy).toBe(true);
    await releaseRuntimeLease(pool, owner);
  });
  it('leaves a bounded busy-channel batch while a neighboring channel makes progress in the same cycle', async () => {
    const world = await createJudgeWorld(pool),
      owner = randomUUID(),
      logger = { error: vi.fn() };
    const enqueue = (channelId: string) =>
      acceptSyntheticCommand(pool, { ...world, channelId }, world.ownerCapability, randomUUID(), {
        type: 'activity',
        actorKey: randomUUID(),
      });
    for (let i = 0; i < 12; i++) await enqueue(world.channelId);
    await enqueue(world.neighborId);
    await runGameCycle(pool, owner, logger);
    const rows = (
      await pool.query<{ id: string; lag: number }>(
        'select id,intake_sequence-processed_sequence as lag from channels where world_id=$1',
        [world.worldId],
      )
    ).rows;
    expect(rows.find((row) => row.id === world.channelId)?.lag).toBe(8);
    expect(rows.find((row) => row.id === world.neighborId)?.lag).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
    await releaseRuntimeLease(pool, owner);
  });
  it('limits each channel to one public transition per turn while its neighbor progresses', async () => {
    const world = await createJudgeWorld(pool),
      owner = randomUUID(),
      logger = { error: vi.fn() };
    for (let i = 0; i < 8; i++)
      await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), {
        type: 'vote',
        actorKey: `turn-${i}`,
        choice: 1,
      });
    await acceptSyntheticCommand(
      pool,
      { ...world, channelId: world.neighborId },
      world.ownerCapability,
      randomUUID(),
      { type: 'activity', actorKey: 'neighbor' },
    );
    await runGameCycle(pool, owner, logger);
    const rows = (
      await pool.query<{ id: string; lag: number }>(
        'select id,intake_sequence-processed_sequence as lag from channels where world_id=$1',
        [world.worldId],
      )
    ).rows;
    expect(rows.find((row) => row.id === world.channelId)?.lag).toBe(7);
    expect(rows.find((row) => row.id === world.neighborId)?.lag).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
    await releaseRuntimeLease(pool, owner);
  });
});
