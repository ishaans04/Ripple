import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeMove, generateMutationCandidates } from './candidates.ts';
import { isLegalGenome, legalMoves, moveId, type Genome, type MutationMove } from './genome.ts';
import { generatorFromSeedMaterial, shuffle } from './random.ts';
import {
  candidateRuleset as rules,
  parseRuleset,
  rulesetCanonicalJson,
  rulesetHash,
} from './ruleset.ts';

const founder: Genome = { pulse: 6, calm: 6, grit: 6, drift: 6 };

const legalGenome = fc
  .tuple(fc.nat(15), fc.nat(15), fc.nat(15))
  .map(([pulse, calm, grit]): Genome => ({ pulse, calm, grit, drift: 24 - pulse - calm - grit }))
  .filter((genome) => isLegalGenome(genome, rules.genome));

const ballotInput = fc.record({
  seed: fc.string({ minLength: 1 }),
  roundId: fc.uuid(),
  genome: legalGenome,
});

describe('generateMutationCandidates', () => {
  it('takes the first three moves of the seeded shuffle of the sorted legal moves', () => {
    const input = { seed: 'world-seed-1', roundId: 'round-1', genome: founder };
    const generator = generatorFromSeedMaterial({
      purpose: 'mutation-candidates',
      seed: 'world-seed-1',
      roundId: 'round-1',
      rulesHash: rulesetHash(rules),
      genome: founder,
    });
    const expected = shuffle(legalMoves(founder, rules.genome), generator).slice(0, 3);
    expect(generateMutationCandidates(input, rules).map((card) => card.move)).toEqual(expected);
  });

  it('keeps producing the recorded cards for a recorded seed', () => {
    // Replay compatibility: changing this output for candidate-1 rewrites history.
    const cards = generateMutationCandidates(
      { seed: 'world-seed-1', roundId: 'round-1', genome: founder },
      rules,
    );
    expect(cards.map((card) => card.id)).toMatchInlineSnapshot(`
      [
        "grit+2/pulse-2",
        "grit+2/drift-2",
        "drift+2/pulse-2",
      ]
    `);
  });

  it('describes each card with its stable id, resulting genome, and named effect', () => {
    const [card] = generateMutationCandidates(
      { seed: 'world-seed-1', roundId: 'round-1', genome: founder },
      rules,
    );
    expect(card).toEqual({
      id: moveId(card!.move),
      move: card!.move,
      genome: {
        ...founder,
        [card!.move.from]: founder[card!.move.from] - 2,
        [card!.move.to]: founder[card!.move.to] + 2,
      },
      ...describeMove(card!.move),
      source: 'generated',
    });
  });

  it('offers three distinct legal mutations that conserve the budget', () => {
    fc.assert(
      fc.property(ballotInput, (input) => {
        const cards = generateMutationCandidates(input, rules);
        expect(cards).toHaveLength(3);
        expect(new Set(cards.map((card) => card.id)).size).toBe(3);
        for (const card of cards) {
          expect(isLegalGenome(card.genome, rules.genome)).toBe(true);
        }
      }),
    );
  });

  it('is reproducible from the recorded inputs', () => {
    fc.assert(
      fc.property(ballotInput, (input) => {
        expect(generateMutationCandidates({ ...input }, rules)).toEqual(
          generateMutationCandidates(input, rules),
        );
      }),
    );
  });

  it('depends on the round, the seed, and the rules version', () => {
    const sets = (vary: (n: number) => Parameters<typeof generateMutationCandidates>) =>
      new Set(
        Array.from({ length: 20 }, (_, n) =>
          generateMutationCandidates(...vary(n))
            .map((card) => card.id)
            .join(),
        ),
      ).size;
    const base = { seed: 's', roundId: 'r', genome: founder };
    expect(sets((n) => [{ ...base, roundId: `r${n}` }, rules])).toBeGreaterThan(1);
    expect(sets((n) => [{ ...base, seed: `s${n}` }, rules])).toBeGreaterThan(1);
    expect(
      sets((n) => [base, parseRuleset({ ...rulesAsJson(), version: `candidate-test-${n}` })]),
    ).toBeGreaterThan(1);
  });

  it('places an eligible dormant move in the last slot', () => {
    const dormantMove: MutationMove = { from: 'calm', to: 'pulse', amount: 2 };
    const cards = generateMutationCandidates(
      { seed: 'world-seed-1', roundId: 'round-2', genome: founder, dormantMove },
      rules,
    );
    expect(cards).toHaveLength(3);
    expect(cards[2]).toMatchObject({
      id: 'pulse+2/calm-2',
      genome: { pulse: 8, calm: 4, grit: 6, drift: 6 },
      source: 'dormant',
    });
    expect(cards.slice(0, 2).every((card) => card.source === 'generated')).toBe(true);
    expect(cards.slice(0, 2).map((card) => card.id)).not.toContain('pulse+2/calm-2');
  });

  it('never duplicates the dormant move among the generated cards', () => {
    fc.assert(
      fc.property(ballotInput, fc.nat(), (input, pick) => {
        const moves = legalMoves(input.genome, rules.genome);
        const dormantMove = moves[pick % moves.length]!;
        const cards = generateMutationCandidates({ ...input, dormantMove }, rules);
        expect(new Set(cards.map((card) => card.id)).size).toBe(3);
        expect(cards.at(-1)?.source).toBe('dormant');
      }),
    );
  });

  it('refuses a dormant move that is illegal for the current genome', () => {
    expect(() =>
      generateMutationCandidates(
        {
          seed: 's',
          roundId: 'r',
          genome: { pulse: 15, calm: 9, grit: 0, drift: 0 },
          dormantMove: { from: 'grit', to: 'calm', amount: 2 },
        },
        rules,
      ),
    ).toThrow(expect.objectContaining({ code: 'ILLEGAL_MOVE' }));
  });

  it('refuses an illegal genome, an empty seed, or an empty round id', () => {
    const bad = { pulse: 6, calm: 6, grit: 6, drift: 7 };
    expect(() =>
      generateMutationCandidates({ seed: 's', roundId: 'r', genome: bad }, rules),
    ).toThrow(expect.objectContaining({ code: 'ILLEGAL_GENOME' }));
    expect(() =>
      generateMutationCandidates({ seed: '', roundId: 'r', genome: founder }, rules),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() =>
      generateMutationCandidates({ seed: 's', roundId: '', genome: founder }, rules),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('reports a ruleset whose genome cannot offer enough distinct moves', () => {
    // Genes of at most 2 summing to 2 with a step of 2: [1, 1, 0, 0] cannot give 2 points.
    const tiny = parseRuleset({
      ...rulesAsJson(),
      genome: {
        min: 0,
        max: 2,
        budget: 2,
        mutationStep: 2,
        founder: { pulse: 1, calm: 1, grit: 0, drift: 0 },
      },
    });
    expect(() =>
      generateMutationCandidates(
        { seed: 's', roundId: 'r', genome: { pulse: 1, calm: 1, grit: 0, drift: 0 } },
        tiny,
      ),
    ).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_CANDIDATES' }));
  });
});

describe('describeMove', () => {
  it.each<[MutationMove, string, string]>([
    [{ from: 'pulse', to: 'grit', amount: 2 }, 'Reinforce shell', 'Less burst affinity'],
    [{ from: 'calm', to: 'pulse', amount: 2 }, 'Specialize for bursts', 'Less steadiness'],
    [{ from: 'drift', to: 'calm', amount: 2 }, 'Settle into steady chat', 'Smaller travel reserve'],
    [{ from: 'grit', to: 'drift', amount: 2 }, 'Pack a travel reserve', 'Thinner shell'],
  ])('names %j for viewers', (move, effect, tradeOff) => {
    expect(describeMove(move)).toEqual({ effect, tradeOff });
  });
});

function rulesAsJson(): Record<string, unknown> {
  return JSON.parse(rulesetCanonicalJson(rules)) as Record<string, unknown>;
}
