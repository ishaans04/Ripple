import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, runMigrations, scanDeadlines } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { candidateRuleset } from '@ripple/engine';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { readSnapshot } from './snapshot.ts';
import { processNextInput, type WorkerReceipt } from './worker.ts';

describe('ordered game worker in real PostgreSQL', () => {
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
    for (let i = 0; i < 100; i++) {
      const result = await processNextInput(pool, world.worldId, world.channelId);
      if (result === null) return results;
      results.push(result);
    }
    throw new Error('Unexpected unbounded input queue.');
  }
  async function accept(world: SyntheticWorld, command: unknown): Promise<void> {
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), command);
  }
  async function start(): Promise<SyntheticWorld> {
    const world = await createSyntheticWorld(pool);
    await accept(world, syntheticSeedCommand());
    await drain(world);
    return world;
  }
  async function cutoff(world: SyntheticWorld): Promise<WorkerReceipt[]> {
    const job = (
      await pool.query<{ due_at: Date }>(
        `select due_at from deadlines where world_id=$1 and status='pending' order by due_at limit 1`,
        [world.worldId],
      )
    ).rows[0];
    if (job === undefined) throw new Error('Expected a persisted deadline.');
    await pool.query('update worlds set clock_at=$2 where id=$1', [world.worldId, job.due_at]);
    await scanDeadlines(pool);
    return drain(world);
  }
  it('applies the first vote once, resolves a limited round, and opens the next mutation slot', async () => {
    const world = await start();
    await accept(world, { type: 'vote', actorKey: 'alice', choice: 2 });
    await accept(world, { type: 'vote', actorKey: 'alice', choice: 3 });
    const results = await drain(world);
    expect(results.map((r) => r.effect.code)).toEqual(['APPLIED', 'ALREADY_VOTED']);
    await cutoff(world);
    const mutated = await readSnapshot(pool, world.worldId, world.channelId);
    expect(mutated?.payload.round?.phase).toBe('OBSERVING');
    const selected = mutated?.payload.round?.candidates[1];
    if (selected === undefined || !('genome' in selected))
      throw new Error('Expected a genetic mutation candidate');
    expect(mutated?.payload.organism?.genome).toEqual(selected.genome);
    await cutoff(world);
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))?.payload.round?.resolution,
    ).toMatchObject({ outcome: 'limited', healthAfter: 70 });
    await cutoff(world);
    expect((await readSnapshot(pool, world.worldId, world.channelId))?.payload.round).toMatchObject(
      { number: 2, phase: 'VOTING' },
    );
  });
  it('deduplicates each account in a bucket and scores real accepted membership', async () => {
    const world = await start();
    await cutoff(world);
    for (const actorKey of ['a', 'a', 'b', 'c'])
      await accept(world, { type: 'activity', actorKey });
    await drain(world);
    await cutoff(world);
    const snapshot = await readSnapshot(pool, world.worldId, world.channelId);
    expect(snapshot?.payload.round?.resolution).toMatchObject({
      outcome: 'applied',
      profile: { contributions: 3, distinctAccounts: 3, burst: 1000 },
    });
    expect(snapshot?.payload.organism?.genome).toEqual(candidateRuleset.genome.founder);
    expect(snapshot?.payload.organism?.health).toBe(69);
  });
  it('serializes competing workers without skipping an earlier accepted input', async () => {
    const world = await start();
    for (let i = 0; i < 10; i++)
      await accept(world, { type: 'vote', actorKey: `actor-${i}`, choice: (i % 3) + 1 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => processNextInput(pool, world.worldId, world.channelId)),
    );
    expect(results.map((r) => r?.sequence).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    const events = await pool.query<{ sequence: number }>(
      'select sequence from game_events where world_id=$1 order by sequence',
      [world.worldId],
    );
    expect(events.rows.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
  it('cuts off votes in durable marker order, including votes that race the close', async () => {
    const world = await start();
    await accept(world, { type: 'vote', actorKey: 'before', choice: 1 });
    // Persist a cutoff while an ingress transaction competes for the same intake lock.
    const job = (
      await pool.query<{ command: unknown; due_at: Date }>(
        'select command,due_at from deadlines where world_id=$1',
        [world.worldId],
      )
    ).rows[0]!;
    await Promise.all([
      acceptInput(pool, {
        worldId: world.worldId,
        channelId: world.channelId,
        provider: 'race',
        messageId: 'close',
        command: job.command,
        acceptedAtMs: job.due_at.getTime(),
      }),
      accept(world, { type: 'vote', actorKey: 'racing', choice: 2 }),
    ]);
    await accept(world, { type: 'vote', actorKey: 'after', choice: 3 });
    await drain(world);
    const rows = await pool.query<{
      sequence: number;
      command: { type: string; actorKey?: string };
      result: { code: string };
    }>('select sequence,command,result from game_events where world_id=$1 order by sequence', [
      world.worldId,
    ]);
    const closeSequence = rows.rows.find((r) => r.command.type === 'deadline')!.sequence;
    for (const event of rows.rows.filter((r) => r.command.type === 'vote'))
      expect(event.result.code).toBe(
        event.sequence < closeSequence ? 'APPLIED' : 'NO_ACTIVE_BALLOT',
      );
  });
  it('retains committed effects and outbox after a worker dies following commit', async () => {
    const world = await start();
    await accept(world, { type: 'vote', actorKey: 'a', choice: 1 });
    const committed = await processNextInput(pool, world.worldId, world.channelId);
    expect(committed?.effect.code).toBe('APPLIED');
    const restarted = new pg.Pool({ connectionString: temporary.connectionString });
    try {
      expect(await processNextInput(restarted, world.worldId, world.channelId)).toBeNull();
      expect(
        (await restarted.query('select * from public_updates where world_id=$1', [world.worldId]))
          .rowCount,
      ).toBe(2);
      expect(
        (await readSnapshot(restarted, world.worldId, world.channelId))?.payload.round?.counts,
      ).toEqual([1, 0, 0]);
    } finally {
      await restarted.end();
    }
  });
  it('reopens observation after an outage, excluding membership from the uncertain epoch', async () => {
    const world = await start();
    await accept(world, { type: 'vote', actorKey: 'a', choice: 1 });
    await drain(world);
    await cutoff(world);
    const genome = (await readSnapshot(pool, world.worldId, world.channelId))?.payload.organism
      ?.genome;
    for (const actorKey of ['a', 'b', 'c']) await accept(world, { type: 'activity', actorKey });
    await accept(world, { type: 'interrupt', reason: 'input_outage' });
    await drain(world);
    expect((await readSnapshot(pool, world.worldId, world.channelId))?.payload.round?.phase).toBe(
      'INTERRUPTED',
    );
    await accept(world, { type: 'integration', online: true, healthy: true });
    await accept(world, { type: 'recover' });
    await drain(world);
    await cutoff(world);
    const snapshot = await readSnapshot(pool, world.worldId, world.channelId);
    expect(snapshot?.payload.organism?.genome).toEqual(genome);
    expect(snapshot?.payload.round?.resolution).toMatchObject({
      outcome: 'limited',
      profile: { contributions: 0 },
      healthAfter: 70,
    });
    expect(
      (await pool.query('select * from habitat_baselines where world_id=$1', [world.worldId]))
        .rowCount,
    ).toBe(0);
  });
});
