import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generateMutationCandidates } from './candidates.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import { resolveMutationBallot, tallyVotes, type BallotVote } from './tally.ts';

function vote(actorKey: string, choice: number): BallotVote {
  return { actorKey, choice };
}

const votes = fc.array(
  fc.record({
    actorKey: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
    choice: fc.integer({ min: 0, max: 4 }),
  }),
);

describe('tallyVotes', () => {
  it('counts one vote per account for each 1-based choice', () => {
    expect(tallyVotes([vote('a', 1), vote('b', 2), vote('c', 2)], 3)).toEqual({
      counts: [1, 2, 0],
      totalVotes: 3,
      winnerIndex: 1,
      ignoredDuplicates: 0,
      ignoredInvalid: 0,
    });
  });

  it("keeps an account's first valid vote and ignores later ones", () => {
    expect(tallyVotes([vote('a', 1), vote('a', 2), vote('a', 1)], 3)).toMatchObject({
      counts: [1, 0, 0],
      winnerIndex: 0,
      ignoredDuplicates: 2,
    });
  });

  it('ignores an invalid choice without consuming the account vote', () => {
    expect(tallyVotes([vote('a', 4), vote('a', 0), vote('a', 1.5), vote('a', 2)], 3)).toMatchObject(
      {
        counts: [0, 1, 0],
        totalVotes: 1,
        ignoredInvalid: 3,
        ignoredDuplicates: 0,
      },
    );
  });

  it('treats a third choice on a two-option ballot as invalid', () => {
    expect(tallyVotes([vote('a', 3), vote('b', 2)], 2)).toMatchObject({
      counts: [0, 1],
      winnerIndex: 1,
      ignoredInvalid: 1,
    });
  });

  it('breaks a tie in favor of the earlier option in seeded order', () => {
    expect(tallyVotes([vote('a', 3), vote('b', 2)], 3).winnerIndex).toBe(1);
    expect(tallyVotes([vote('a', 3), vote('b', 2), vote('c', 1)], 3).winnerIndex).toBe(0);
  });

  it('has no winner when no valid vote was cast', () => {
    expect(tallyVotes([], 3).winnerIndex).toBeNull();
    expect(tallyVotes([vote('a', 9)], 3)).toMatchObject({ winnerIndex: null, totalVotes: 0 });
  });

  it('cannot be changed by votes from accounts that already voted', () => {
    fc.assert(
      fc.property(votes, votes, (first, later) => {
        const before = tallyVotes(first, 3);
        const voted = new Set(
          first
            .filter((v) => Number.isInteger(v.choice) && v.choice >= 1 && v.choice <= 3)
            .map((v) => v.actorKey),
        );
        const after = tallyVotes([...first, ...later.filter((v) => voted.has(v.actorKey))], 3);
        expect(after.counts).toEqual(before.counts);
        expect(after.winnerIndex).toBe(before.winnerIndex);
      }),
    );
  });

  it('accounts for every vote as counted, duplicate, or invalid', () => {
    fc.assert(
      fc.property(votes, (cast) => {
        const result = tallyVotes(cast, 3);
        expect(result.counts.reduce((sum, n) => sum + n, 0)).toBe(result.totalVotes);
        expect(result.totalVotes + result.ignoredDuplicates + result.ignoredInvalid).toBe(
          cast.length,
        );
        if (result.winnerIndex !== null) {
          expect(result.counts[result.winnerIndex]).toBe(Math.max(...result.counts));
          expect(result.counts.indexOf(Math.max(...result.counts))).toBe(result.winnerIndex);
        }
      }),
    );
  });

  it('rejects an empty ballot and an empty account key', () => {
    expect(() => tallyVotes([], 0)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => tallyVotes([vote('', 1)], 3)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});

describe('resolveMutationBallot', () => {
  const founder = { pulse: 6, calm: 6, grit: 6, drift: 6 };
  const cards = generateMutationCandidates({ seed: 's', roundId: 'r', genome: founder }, rules);

  it('selects the winning card', () => {
    const result = resolveMutationBallot(cards, [vote('a', 2), vote('b', 2), vote('c', 1)]);
    expect(result.outcome).toEqual({ kind: 'mutation', index: 1, candidate: cards[1] });
    expect(result.tally.counts).toEqual([1, 2, 0]);
  });

  it('holds the genome when nobody votes', () => {
    expect(resolveMutationBallot(cards, []).outcome).toEqual({ kind: 'hold' });
  });
});
