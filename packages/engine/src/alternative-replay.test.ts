import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { replayRejectedChoices } from './alternative-replay.ts';
import { describeMove, generateMutationCandidates, type MutationCandidate } from './candidates.ts';
import { applyMove, isLegalGenome, moveId, type Genome, type MutationMove } from './genome.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import type { ScoreInput, TraceTemplate } from './scoring.ts';

const genome: Genome = { pulse: 6, calm: 6, grit: 6, drift: 6 };
const cards = generateMutationCandidates(
  { seed: 'comparison', roundId: 'recorded-round', genome },
  rules,
);
const actual: ScoreInput = {
  genome,
  healthBefore: 70,
  profile: { burst: 900, steadiness: 100 },
  shocks: [],
  trace: null,
};
const legalGenome = fc
  .tuple(fc.nat(15), fc.nat(15), fc.nat(15))
  .map(([pulse, calm, grit]): Genome => ({ pulse, calm, grit, drift: 24 - pulse - calm - grit }))
  .filter((g) => isLegalGenome(g, rules.genome));
describe('fixed-input rejected-choice replay', () => {
  it('recomputes protection and trace costs instead of borrowing the chosen genome effects', () => {
    const choices: MutationCandidate[] = (
      [
        { from: 'pulse', to: 'grit', amount: 2 },
        { from: 'grit', to: 'pulse', amount: 2 },
        { from: 'drift', to: 'calm', amount: 2 },
      ] satisfies MutationMove[]
    ).map((move) => ({
      id: moveId(move),
      move,
      genome: applyMove(genome, move, rules.genome)!,
      ...describeMove(move),
      source: 'generated',
    }));
    const replay = replayRejectedChoices(
      {
        genomeBefore: genome,
        candidates: choices,
        selectedId: choices[0]!.id,
        actual: {
          ...actual,
          genome: choices[0]!.genome,
          healthBefore: 99,
          profile: { burst: 1000, steadiness: 0 },
          shocks: [
            { kind: 'arrival', amount: 4 },
            { kind: 'category_change', amount: 4 },
          ],
          trace: 'recovery',
        },
      },
      rules,
    );
    expect(replay.actual).toMatchObject({
      gritProtection: 4,
      rawShock: 8,
      delta: -6,
      healthAfter: 93,
    });
    expect(replay.rejected[0]).toMatchObject({
      kind: 'rejected-choice',
      score: { gritProtection: 2, rawShock: 8, delta: -7, healthAfter: 92 },
      energyDifference: -1,
    });
  });
  it('evaluates all three rejected cards when the actual ballot held with no votes', () => {
    const replay = replayRejectedChoices(
      { genomeBefore: genome, candidates: cards, selectedId: null, actual },
      rules,
    );
    expect(replay.rejected.map((c) => c.candidateId)).toEqual(cards.map((c) => c.id));
    expect(replay.actual.genome).toEqual(genome);
  });
  it('keeps rejected outcomes independent of which other card won and leaves recorded inputs untouched', () => {
    fc.assert(
      fc.property(
        legalGenome,
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.constantFrom<TraceTemplate | null>(null, 'shelter', 'charged', 'recovery'),
        (before, health, burst, trace) => {
          const candidates = generateMutationCandidates(
            { seed: 'property', roundId: 'record', genome: before },
            rules,
          );
          const fixed = {
            healthBefore: health,
            profile: { burst, steadiness: 1000 - burst },
            shocks: [{ kind: 'arrival' as const, amount: 4 }],
            trace,
          };
          const saved = structuredClone({ before, candidates, fixed });
          const outcomes = candidates.map((selected) =>
            replayRejectedChoices(
              {
                genomeBefore: before,
                candidates,
                selectedId: selected.id,
                actual: { ...fixed, genome: selected.genome },
              },
              rules,
            ),
          );
          expect(new Set(outcomes.map((o) => o.exogenousHash)).size).toBe(1);
          expect(
            outcomes[0]!.rejected.find((c) => c.candidateId === candidates[2]!.id)?.score,
          ).toEqual(outcomes[1]!.rejected.find((c) => c.candidateId === candidates[2]!.id)?.score);
          expect({ before, candidates, fixed }).toEqual(saved);
          for (const outcome of outcomes)
            for (const rejected of outcome.rejected)
              expect(rejected.energyDifference).toBe(
                rejected.score.healthAfter - outcome.actual.healthAfter,
              );
        },
      ),
      { numRuns: 300 },
    );
  });
  it('rejects edited cards, an unrecorded choice and an actual genome that did not result from the ballot', () => {
    expect(() =>
      replayRejectedChoices(
        {
          genomeBefore: genome,
          candidates: [cards[0]!, cards[0]!, cards[2]!],
          selectedId: null,
          actual,
        },
        rules,
      ),
    ).toThrow();
    expect(() =>
      replayRejectedChoices(
        { genomeBefore: genome, candidates: cards, selectedId: 'invented', actual },
        rules,
      ),
    ).toThrow();
    expect(() =>
      replayRejectedChoices(
        { genomeBefore: genome, candidates: cards, selectedId: cards[0]!.id, actual },
        rules,
      ),
    ).toThrow();
    const edited = cards.map((c) => ({ ...c, genome }));
    expect(() =>
      replayRejectedChoices(
        { genomeBefore: genome, candidates: edited, selectedId: null, actual },
        rules,
      ),
    ).toThrow();
  });
});
