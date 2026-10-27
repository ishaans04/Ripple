import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { MutationCandidate } from './candidates.ts';
import { evaluateDormantOffer, selectDormantCapture, type DormantCapture } from './dormant.ts';
import { applyMove, isLegalGenome, moveId, type Genome, type MutationMove } from './genome.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import { tallyVotes, type BallotVote } from './tally.ts';

const founder: Genome = { pulse: 6, calm: 6, grit: 6, drift: 6 };

function card(
  from: MutationMove['from'],
  to: MutationMove['to'],
  source: MutationCandidate['source'] = 'generated',
): MutationCandidate {
  const move: MutationMove = { from, to, amount: 2 };
  return {
    id: moveId(move),
    move,
    genome: applyMove(founder, move, rules.genome)!,
    effect: '',
    tradeOff: '',
    source,
  };
}

// The worked journey's ballot at source A.
const journeyCards = [card('drift', 'calm'), card('calm', 'pulse'), card('pulse', 'grit')];

function votesFor(counts: readonly number[]): BallotVote[] {
  return counts.flatMap((count, index) =>
    Array.from({ length: count }, (_, n) => ({
      actorKey: `option${index}-voter${n}`,
      choice: index + 1,
    })),
  );
}

function capture(counts: readonly number[], cards = journeyCards) {
  return selectDormantCapture(
    { candidates: cards, tally: tallyVotes(votesFor(counts), cards.length), captureBurst: 200 },
    rules,
  );
}

describe('selectDormantCapture', () => {
  it('preserves a two-vote runner-up of a ten-vote ballot (worked journey)', () => {
    expect(capture([8, 2, 0])).toEqual({
      move: { from: 'calm', to: 'pulse', amount: 2 },
      supporters: 2,
      totalVotes: 10,
      captureBurst: 200,
    });
  });

  it.each([
    ['four votes in total', [3, 1, 0]],
    ['four votes even with a strong runner-up', [2, 2, 0]],
    ['a one-vote runner-up', [5, 1, 0]],
    ['a runner-up under 20 percent', [9, 2, 0]],
    ['no losing votes', [7, 0, 0]],
    ['no votes at all', [0, 0, 0]],
  ])('captures nothing with %s', (_label, counts) => {
    expect(capture(counts)).toBeNull();
  });

  it.each([
    ['exactly five votes', [3, 2, 0], 1],
    ['exactly 20 percent', [8, 2, 0], 1],
    ['a tied runner-up, by seeded order', [6, 2, 2], 1],
    ['a tied winner, keeping the later card', [3, 3, 0], 1],
    ['the third card', [5, 0, 3], 2],
  ])('captures with %s', (_label, counts, index) => {
    expect(capture(counts)?.move).toEqual(journeyCards[index]!.move);
  });

  it('never re-captures a rejected dormant card', () => {
    const cards = [card('drift', 'calm'), card('pulse', 'grit'), card('calm', 'pulse', 'dormant')];
    // The rejected dormant card is the runner-up: its one offer is consumed and
    // the third-placed card is not promoted in its place.
    expect(capture([5, 2, 3], cards)).toBeNull();
    // A generated runner-up is preserved as usual.
    expect(capture([5, 3, 2], cards)?.move).toEqual(cards[1]!.move);
  });

  it('refuses a tally for a different ballot', () => {
    expect(() =>
      selectDormantCapture(
        { candidates: journeyCards, tally: tallyVotes([], 2), captureBurst: 200 },
        rules,
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});

describe('evaluateDormantOffer', () => {
  const journeyCapture: DormantCapture = {
    move: { from: 'calm', to: 'pulse', amount: 2 },
    supporters: 2,
    totalVotes: 10,
    captureBurst: 200,
  };
  const current: Genome = { pulse: 6, calm: 8, grit: 6, drift: 4 };

  it('offers the rebased move when the habitat changed and it fits better (worked journey, B)', () => {
    expect(
      evaluateDormantOffer(
        {
          capture: journeyCapture,
          genome: current,
          recentProfile: { burst: 900, steadiness: 100 },
        },
        rules,
      ),
    ).toEqual({
      eligible: true,
      move: { from: 'calm', to: 'pulse', amount: 2 },
      rebasedGenome: { pulse: 8, calm: 6, grit: 6, drift: 4 },
      profileChange: 700,
      currentFit: 2,
      rebasedFit: 3,
    });
  });

  it('requires a known valid profile', () => {
    expect(
      evaluateDormantOffer(
        { capture: journeyCapture, genome: current, recentProfile: null },
        rules,
      ),
    ).toEqual({
      eligible: false,
      reason: 'no_valid_profile',
    });
  });

  it('requires a change of at least 300 burst units in either direction', () => {
    const at = (burst: number) =>
      evaluateDormantOffer(
        {
          capture: { ...journeyCapture, captureBurst: 600 },
          genome: current,
          recentProfile: { burst, steadiness: 1000 - burst },
        },
        rules,
      );
    expect(at(899)).toEqual({ eligible: false, reason: 'profile_unchanged' });
    expect(at(301)).toEqual({ eligible: false, reason: 'profile_unchanged' });
    expect(at(900).eligible).toBe(true);
    // A drop of exactly 300 qualifies on change, but toward steadiness Pulse no longer fits better.
    expect(at(300)).toEqual({ eligible: false, reason: 'no_fit_gain' });
  });

  it('withholds a move that cannot be rebased legally', () => {
    const lowCalm: Genome = { pulse: 15, calm: 1, grit: 4, drift: 4 };
    expect(
      evaluateDormantOffer(
        {
          capture: journeyCapture,
          genome: lowCalm,
          recentProfile: { burst: 900, steadiness: 100 },
        },
        rules,
      ),
    ).toEqual({ eligible: false, reason: 'illegal_rebase' });
  });

  it('withholds a move whose estimated fit is not strictly higher', () => {
    // At burst 500 both [6,8,6,4] and [8,6,6,4] estimate 6 * 7000 / 15000 = 2.8 -> 3.
    expect(
      evaluateDormantOffer(
        {
          capture: journeyCapture,
          genome: current,
          recentProfile: { burst: 500, steadiness: 500 },
        },
        rules,
      ),
    ).toEqual({ eligible: false, reason: 'no_fit_gain' });
  });

  it('only ever offers a legal move that improves the estimate after a large enough change', () => {
    const legalGenome = fc
      .tuple(fc.nat(15), fc.nat(15), fc.nat(15))
      .map(([pulse, calm, grit]): Genome => ({
        pulse,
        calm,
        grit,
        drift: 24 - pulse - calm - grit,
      }))
      .filter((g) => isLegalGenome(g, rules.genome));
    const gene = fc.constantFrom('pulse', 'calm', 'grit', 'drift' as const);
    fc.assert(
      fc.property(
        legalGenome,
        gene,
        gene,
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (genome, from, to, captureBurst, burst) => {
          fc.pre(from !== to);
          const result = evaluateDormantOffer(
            {
              capture: {
                move: { from, to, amount: 2 },
                supporters: 2,
                totalVotes: 5,
                captureBurst,
              },
              genome,
              recentProfile: { burst, steadiness: 1000 - burst },
            },
            rules,
          );
          if (result.eligible) {
            expect(isLegalGenome(result.rebasedGenome, rules.genome)).toBe(true);
            expect(result.rebasedFit).toBeGreaterThan(result.currentFit);
            expect(result.profileChange).toBeGreaterThanOrEqual(300);
          }
        },
      ),
    );
  });
});
