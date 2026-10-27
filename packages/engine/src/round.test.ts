import { describe, expect, it } from 'vitest';
import { liveRoundTimings } from '@ripple/contracts';
import { initialMutationSlots } from './studio-slots.ts';
import { candidateRuleset } from './ruleset.ts';
import { closeMutationRound, finishRoundObservation, openMutationRound } from './round.ts';

const checkpoint = openMutationRound(
  {
    seed: 'recorded',
    roundId: 'round-1',
    genome: candidateRuleset.genome.founder,
    history: [],
    atMs: 0,
    timings: liveRoundTimings,
  },
  candidateRuleset,
);
describe('round checkpoints', () => {
  it('retains Hold and consumes exactly one slot even without votes', () => {
    const closed = closeMutationRound(checkpoint, [], initialMutationSlots, 'close-1');
    expect(closed.genome).toEqual(candidateRuleset.genome.founder);
    expect(closed.choiceId).toBeNull();
    expect(closed.slots).toMatchObject({ next: 2, observedThrough: 0 });
    expect(closeMutationRound(checkpoint, [], closed.slots, 'close-1').slots).toBe(closed.slots);
  });
  it('holds health on low confidence but permits the next ordinary mutation', () => {
    const closed = closeMutationRound(
      checkpoint,
      [{ actorKey: 'a', choice: 2 }],
      initialMutationSlots,
      'close-1',
    );
    const finished = finishRoundObservation(
      { checkpoint, genome: closed.genome, health: 70, slots: closed.slots, observations: [] },
      candidateRuleset,
    );
    expect(finished.resolution).toMatchObject({ outcome: 'limited', healthAfter: 70 });
    expect(finished.slots.observedThrough).toBe(1);
    expect(
      openMutationRound(
        {
          seed: 'recorded',
          roundId: 'round-2',
          genome: closed.genome,
          history: [],
          atMs: 180_000,
          timings: liveRoundTimings,
        },
        candidateRuleset,
      ).candidates,
    ).toHaveLength(3);
  });
});
