import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { runAncestorTrial } from './ancestor.ts';
import { isLegalGenome, type Genome } from './genome.ts';
import { arrivalShock, categoryChangeShock } from './habitat.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import type { ScoreInput, TraceTemplate } from './scoring.ts';

const founder: Genome = { pulse: 6, calm: 6, grit: 6, drift: 6 };

const journeyRound: ScoreInput = {
  genome: { pulse: 8, calm: 6, grit: 6, drift: 4 },
  healthBefore: 28,
  profile: { burst: 900, steadiness: 100 },
  shocks: [],
  trace: null,
};

const legalGenome = fc
  .tuple(fc.nat(15), fc.nat(15), fc.nat(15))
  .map(([pulse, calm, grit]): Genome => ({ pulse, calm, grit, drift: 24 - pulse - calm - grit }))
  .filter((g) => isLegalGenome(g, rules.genome));

const anyRound = fc.record({
  genome: legalGenome,
  healthBefore: fc.integer({ min: 1, max: 100 }),
  profile: fc.integer({ min: 0, max: 1000 }).map((burst) => ({ burst, steadiness: 1000 - burst })),
  shocks: fc.array(fc.constantFrom(arrivalShock(rules), categoryChangeShock(rules)), {
    maxLength: 3,
  }),
  trace: fc.constantFrom<TraceTemplate | null>(null, 'shelter', 'charged', 'recovery'),
});

describe('runAncestorTrial', () => {
  it('scores the founding genome beside the living one (worked journey)', () => {
    const trial = runAncestorTrial(journeyRound, founder, rules);
    expect(trial.current).toMatchObject({ fit: 3, upkeep: 3, delta: 0, healthAfter: 28 });
    expect(trial.ancestor).toMatchObject({
      genome: founder,
      fit: 2,
      upkeep: 3,
      delta: -1,
      healthAfter: 27,
    });
    expect(trial).toMatchObject({
      identicalGenome: false,
      fitnessDifference: 1,
      deltaDifference: 1,
    });
  });

  it('recomputes Grit protection for each genome instead of copying it', () => {
    const trial = runAncestorTrial(
      {
        ...journeyRound,
        genome: { pulse: 11, calm: 9, grit: 2, drift: 2 },
        shocks: [arrivalShock(rules)],
      },
      founder,
      rules,
    );
    expect(trial.current).toMatchObject({ gritProtection: 1, shock: 3 });
    expect(trial.ancestor).toMatchObject({ gritProtection: 3, shock: 1 });
  });

  it('applies the same trace rule to both genomes', () => {
    const trial = runAncestorTrial({ ...journeyRound, trace: 'charged' }, founder, rules);
    expect(trial.current.trace).toEqual(trial.ancestor.trace);
  });

  it('reports equal contributions for identical genomes', () => {
    fc.assert(
      fc.property(anyRound, (round) => {
        const trial = runAncestorTrial(round, round.genome, rules);
        expect(trial.identicalGenome).toBe(true);
        expect(trial.ancestor).toEqual(trial.current);
        expect(trial.fitnessDifference).toBe(0);
        expect(trial.deltaDifference).toBe(0);
      }),
    );
  });

  it('cannot be skewed by start health', () => {
    fc.assert(
      fc.property(
        anyRound,
        legalGenome,
        fc.integer({ min: 1, max: 100 }),
        (round, ancestor, health) => {
          const base = runAncestorTrial(round, ancestor, rules);
          const other = runAncestorTrial({ ...round, healthBefore: health }, ancestor, rules);
          expect(other.fitnessDifference).toBe(base.fitnessDifference);
        },
      ),
    );
  });

  it('matches every non-genetic input of the live score', () => {
    fc.assert(
      fc.property(anyRound, legalGenome, (round, ancestor) => {
        const { current, ancestor: shadow } = runAncestorTrial(round, ancestor, rules);
        expect(shadow.genome).toEqual(ancestor);
        expect(current.genome).toEqual(round.genome);
        for (const key of [
          'healthBefore',
          'burst',
          'steadiness',
          'upkeep',
          'rawShock',
          'arrivalShock',
          'categoryShock',
        ] as const) {
          expect(shadow[key]).toBe(current[key]);
        }
      }),
    );
  });

  it('rejects an illegal ancestor genome', () => {
    expect(() =>
      runAncestorTrial(journeyRound, { pulse: 9, calm: 9, grit: 9, drift: 9 }, rules),
    ).toThrow(expect.objectContaining({ code: 'ILLEGAL_GENOME' }));
  });
});
