import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  candidateRuleset,
  evaluateDormantOffer,
  generateMutationCandidates,
  type MutationCandidate,
} from '@ripple/engine';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { readSnapshot } from './snapshot.ts';
import { canonicalGameProjection, exportAcceptedChannel, replayAcceptedChannel } from './replay.ts';
import type { DormantRow } from './dormant-state.ts';

describe('one explicit minority offer in an ordinary three-card ballot', () => {
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
  /** Choose a fixed recorded seed/round that exercises a legal favorable later direction. */
  function scenario() {
    const roundId = '00000000-0000-4000-8000-000000000042';
    for (let i = 0; i < 100; i++) {
      const seed = `minority-offer-${i}`;
      const cards = generateMutationCandidates(
        { seed, roundId, genome: candidateRuleset.genome.founder },
        candidateRuleset,
      );
      for (const [winnerIndex, winner] of cards.entries())
        for (const [runnerIndex, runner] of cards.entries()) {
          if (
            winnerIndex !== runnerIndex &&
            evaluateDormantOffer(
              {
                capture: { move: runner.move, supporters: 2, totalVotes: 5, captureBurst: 0 },
                genome: winner.genome,
                recentProfile: { burst: 1000, steadiness: 0 },
              },
              candidateRuleset,
            ).eligible
          )
            return { seed, roundId, cards, winnerIndex, runnerIndex };
        }
    }
    throw new Error('Missing deterministic favorable minority scenario.');
  }
  it.each([true, false])(
    'consumes the one offer when selected=%s and never adds a fourth card or a second offer',
    async (selected) => {
      const fixture = scenario(),
        world = await createSyntheticWorld(pool, { seed: fixture.seed, mechanicsVersion: 1 });
      await send(world, syntheticSeedCommand());
      await advance(world, 3200);
      for (let bucket = 0; bucket < 12; bucket++) {
        await send(world, { type: 'activity', actorKey: `steady-${bucket % 3}` });
        await advance(world, 1000);
      }
      // The durable scheduler's next-round identifier is fixture input, frozen before its cutoff is accepted.
      await pool.query(
        "update deadlines set command=jsonb_set(command,'{nextRoundId}',to_jsonb($3::text)) where world_id=$1 and channel_id=$2 and status='pending' and command->>'type'='deadline'",
        [world.worldId, world.channelId, fixture.roundId],
      );
      await advance(world, 800);
      const captureRound = (await readSnapshot(pool, world.worldId, world.channelId))!.payload
        .round!;
      expect(captureRound.id).toBe(fixture.roundId);
      expect(captureRound.candidates).toEqual(fixture.cards);
      for (let i = 0; i < 3; i++)
        await send(world, {
          type: 'vote',
          actorKey: `winner-${i}`,
          choice: fixture.winnerIndex + 1,
        });
      for (let i = 0; i < 2; i++)
        await send(world, {
          type: 'vote',
          actorKey: `runner-${i}`,
          choice: fixture.runnerIndex + 1,
        });
      await advance(world, 3200);
      const captured = (
        await pool.query<DormantRow>('select * from dormant_mutations where world_id=$1', [
          world.worldId,
        ])
      ).rows[0]!;
      expect(captured.provenance.captureProfile).toMatchObject({ burst: 0 });
      expect(captured.offered).toBe(false);
      await activity(world);
      await advance(world, 12000);
      await advance(world, 800);
      const opened = (await readSnapshot(pool, world.worldId, world.channelId))!.payload;
      const cards = opened.round!.candidates as readonly MutationCandidate[];
      expect(cards).toHaveLength(3);
      expect(new Set(cards.map((card) => card.id)).size).toBe(3);
      expect(cards[2]!.source).toBe('dormant');
      expect(cards[2]!.move).toEqual(captured.template);
      expect(opened.round!.dormantOffer).toMatchObject({
        id: captured.id,
        sourceRoundId: fixture.roundId,
        supporters: 2,
        totalVotes: 5,
      });
      expect(
        cards.every((card) => Object.values(card.genome).reduce((sum, n) => sum + n, 0) === 24),
      ).toBe(true);
      await send(world, { type: 'interrupt', reason: 'input_outage' });
      await send(world, { type: 'integration', online: true, healthy: true });
      await send(world, { type: 'recover' });
      expect(
        (await readSnapshot(pool, world.worldId, world.channelId))!.payload.round!.candidates,
      ).toEqual(cards);
      if (!selected) {
        const childId = randomUUID();
        await send(world, {
          type: 'raid',
          transferId: randomUUID(),
          childId,
          residencyId: randomUUID(),
          arrivalRoundId: randomUUID(),
          destinationChannelId: null,
          destinationTwitchId: randomUUID(),
          retainUnenrolled: true,
        });
        expect(
          (
            await pool.query<DormantRow>(
              'select * from dormant_mutations where world_id=$1 and organism_id=$2',
              [world.worldId, childId],
            )
          ).rows[0],
        ).toMatchObject({ offered: true, remaining_rounds: 3 });
      }
      const choice = selected ? 3 : 1;
      await send(world, { type: 'vote', actorKey: 'choose', choice });
      await advance(world, 3200);
      const consumed = (
        await pool.query<{
          status: string;
          consumption: { reason: string };
          remaining_rounds: number;
        }>('select * from dormant_mutations where world_id=$1 and id=$2', [
          world.worldId,
          captured.id,
        ])
      ).rows[0]!;
      expect(consumed).toMatchObject({
        status: 'consumed',
        consumption: { reason: selected ? 'selected' : 'rejected' },
        remaining_rounds: 3,
      });
      expect(
        (await readSnapshot(pool, world.worldId, world.channelId))!.payload.organism!.genome,
      ).toEqual(cards[choice - 1]!.genome);
      await activity(world);
      await advance(world, 12000);
      await advance(world, 800);
      expect(
        (await readSnapshot(pool, world.worldId, world.channelId))!.payload.round!.candidates.every(
          (card) => 'source' in card && card.source === 'generated',
        ),
      ).toBe(true);
      const replay = await replayAcceptedChannel(pool, await exportAcceptedChannel(pool, world));
      expect(await canonicalGameProjection(pool, replay)).toBe(
        await canonicalGameProjection(pool, world),
      );
    },
  );
});
