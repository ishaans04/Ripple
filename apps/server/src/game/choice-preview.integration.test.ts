import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { channelViewSchema } from '@ripple/contracts';
import { candidateRuleset, previewMutationChoices, type MutationCandidate } from '@ripple/engine';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { readSnapshot } from './snapshot.ts';

describe('frozen recent-profile ballot previews', () => {
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
  async function snapshot(world: SyntheticWorld) {
    const saved = await readSnapshot(pool, world.worldId, world.channelId);
    expect(channelViewSchema.safeParse(saved!.payload).success).toBe(true);
    return saved!.payload;
  }
  it('starts Learning, then freezes estimates against the last valid profile with source attribution', async () => {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    const seed = syntheticSeedCommand();
    await send(world, seed);
    expect((await snapshot(world)).round!.choicePreview).toMatchObject({
      status: 'learning',
      cards: [],
    });
    await send(world, { type: 'vote', actorKey: 'mutate', choice: 2 });
    await advance(world, 3200);
    for (const actorKey of ['a', 'b', 'c']) await send(world, { type: 'activity', actorKey });
    await advance(world, 12000);
    await advance(world, 800);
    const opened = await snapshot(world),
      preview = opened.round!.choicePreview!;
    expect(preview).toMatchObject({
      status: 'estimate',
      sourceRoundId: seed.roundId,
      label: 'Based on recent activity',
    });
    const previous = (
      await pool.query<{ burst: number }>(
        'select burst from habitat_baselines where world_id=$1 and round_id=$2',
        [world.worldId, seed.roundId],
      )
    ).rows[0]!;
    expect(preview).toEqual(
      previewMutationChoices(
        {
          genome: opened.organism!.genome,
          healthBefore: opened.organism!.health,
          candidates: opened.round!.candidates as readonly MutationCandidate[],
          recent: {
            roundId: seed.roundId,
            profile: { burst: previous.burst, steadiness: 1000 - previous.burst },
          },
          trace: null,
        },
        candidateRuleset,
      ),
    );
    await send(world, { type: 'vote', actorKey: 'another-mutation', choice: 1 });
    await advance(world, 3200);
    await send(world, { type: 'shock', kind: 'category_change' });
    for (let bucket = 0; bucket < 3; bucket++) {
      await send(world, { type: 'activity', actorKey: `new-${bucket}` });
      if (bucket < 2) await advance(world, 1000);
    }
    await advance(world, 10000);
    expect((await snapshot(world)).round!.choicePreview).toEqual(preview);
  });
  it('does not treat a limited round as a known profile or add estimates to legacy sessions', async () => {
    for (const mechanicsVersion of [0, 1] as const) {
      const world = await createSyntheticWorld(pool, { mechanicsVersion });
      await send(world, syntheticSeedCommand());
      await advance(world, 3200);
      await advance(world, 12000);
      await advance(world, 800);
      const preview = (await snapshot(world)).round!.choicePreview;
      if (mechanicsVersion === 0) expect(preview).toBeUndefined();
      else
        expect(preview).toMatchObject({
          status: 'learning',
          reason: 'No valid habitat profile yet',
        });
    }
  });
});
