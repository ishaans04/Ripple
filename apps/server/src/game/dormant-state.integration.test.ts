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
import { canonicalGameProjection, exportAcceptedChannel, replayAcceptedChannel } from './replay.ts';
import type { DormantRow } from './dormant-state.ts';
import { readSnapshot } from './snapshot.ts';

describe('dormant minority capture and valid-round expiry', () => {
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
  async function vote(world: SyntheticWorld, counts: readonly number[]) {
    for (const [index, count] of counts.entries())
      for (let i = 0; i < count; i++)
        await send(world, { type: 'vote', actorKey: `minority-${index}-${i}`, choice: index + 1 });
  }
  async function activity(world: SyntheticWorld) {
    for (const actorKey of ['a', 'b', 'c']) await send(world, { type: 'activity', actorKey });
  }
  async function rows(world: SyntheticWorld) {
    return (
      await pool.query<DormantRow & { status: string; consumption: unknown }>(
        'select * from dormant_mutations where world_id=$1 order by source_round_id',
        [world.worldId],
      )
    ).rows;
  }
  async function start() {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(world, syntheticSeedCommand());
    return world;
  }
  it('captures aggregate support at five/two and expires after exactly three later valid closes', async () => {
    const world = await start();
    await vote(world, [3, 2, 0]);
    await advance(world, 3200);
    const captured = (await rows(world))[0]!;
    expect(captured).toMatchObject({
      remaining_rounds: 3,
      offered: false,
      status: 'active',
      provenance: { supporters: 2, totalVotes: 5, captureProfile: null },
    });
    expect(JSON.stringify(captured.provenance)).not.toContain('minority-');
    const visible = (await readSnapshot(pool, world.worldId, world.channelId))!.payload.mechanics
      .state.dormant;
    expect(visible).toMatchObject([
      {
        id: captured.id,
        remainingRounds: 3,
        supporters: 2,
        totalVotes: 5,
        originChannelId: world.channelId,
        inherited: false,
        offered: false,
      },
    ]);
    expect(JSON.stringify(visible)).not.toMatch(
      /minority-|actorKey|captureSequence|captureProfile/,
    );
    const other = await start();
    expect(
      (await readSnapshot(pool, other.worldId, other.channelId))!.payload.mechanics.state.dormant,
    ).toEqual([]);
    await activity(world);
    await advance(world, 12000);
    expect((await rows(world))[0]!.remaining_rounds).toBe(3);
    for (const remaining of [2, 1, 0]) {
      await advance(world, 800);
      await advance(world, 3200);
      await activity(world);
      await advance(world, 12000);
      expect((await rows(world))[0]!.remaining_rounds).toBe(remaining);
    }
    const expired = (await rows(world))[0]!;
    expect(expired.status).toBe('expired');
    expect(expired.lifetime.countedRoundIds).toHaveLength(3);
    expect(expired.lifetime.countedRoundIds).not.toContain(expired.source_round_id);
    expect(expired.consumption).toMatchObject({ reason: 'valid-round-expiry' });
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))!.payload.mechanics.state.dormant,
    ).toEqual([]);
    const replay = await replayAcceptedChannel(pool, await exportAcceptedChannel(pool, world));
    expect(await canonicalGameProjection(pool, replay)).toBe(
      await canonicalGameProjection(pool, world),
    );
  }, 20000);
  it('does not age during limited, paused or interrupted observations and replaces provenance explicitly', async () => {
    const world = await start();
    await vote(world, [3, 2, 0]);
    await advance(world, 3200);
    const first = (await rows(world))[0]!;
    await advance(world, 12000);
    expect((await rows(world))[0]!.remaining_rounds).toBe(3);
    await send(world, { type: 'pause', reason: 'manual' });
    await advance(world, 300000);
    expect((await rows(world))[0]!).toEqual(first);
    await send(world, { type: 'resume' });
    await advance(world, 800);
    await vote(world, [3, 2, 0]);
    await advance(world, 3200);
    const captured = await rows(world);
    expect(captured).toHaveLength(2);
    expect(captured.find((row) => row.id === first.id)!.status).toBe('replaced');
    const replacement = captured.find((row) => row.id !== first.id)!;
    expect(replacement.remaining_rounds).toBe(3);
    await activity(world);
    await send(world, { type: 'interrupt', reason: 'input_outage' });
    await advance(world, 20000);
    expect((await rows(world)).find((row) => row.id === replacement.id)!.remaining_rounds).toBe(3);
    await send(world, { type: 'integration', online: true, healthy: true });
    await send(world, { type: 'recover' });
    await activity(world);
    await advance(world, 12000);
    expect((await rows(world)).find((row) => row.id === replacement.id)!.remaining_rounds).toBe(3);
    expect((await rows(world)).find((row) => row.id === first.id)!.consumption).toMatchObject({
      reason: 'replaced',
    });
  }, 20000);
  it('rejects insufficient support without creating a dormant record', async () => {
    for (const counts of [
      [2, 2, 0],
      [4, 1, 0],
      [5, 0, 0],
    ]) {
      const world = await start();
      await vote(world, counts);
      await advance(world, 3200);
      expect(await rows(world)).toEqual([]);
    }
  });
});
