import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { freezeBaseline } from './baseline.ts';
import type { Genome } from './genome.ts';
import { arrivalShock, buildActivityProfile, type ActivityObservation } from './habitat.ts';
import { resolveObservation, type ResolutionInput } from './resolution.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import { scoreRound } from './scoring.ts';

function observationsFromBuckets(counts: readonly number[]): ActivityObservation[] {
  return counts.flatMap((count, bucket) =>
    Array.from({ length: count }, (_, n) => ({
      actorKey: `actor-${n}`,
      offsetMs: bucket * 10_000,
    })),
  );
}

const steadyChat = observationsFromBuckets([4, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
const learning = freezeBaseline([], rules);
const established = freezeBaseline(
  [
    { roundId: 'r1', contributions: 10, burst: 200, confidence: 'confident' },
    { roundId: 'r2', contributions: 20, burst: 400, confidence: 'confident' },
    { roundId: 'r3', contributions: 30, burst: 900, confidence: 'confident' },
  ],
  rules,
);

function input(overrides: Partial<ResolutionInput> = {}): ResolutionInput {
  return {
    genome: { pulse: 6, calm: 8, grit: 6, drift: 4 },
    healthBefore: 70,
    observation: { status: 'complete', observations: steadyChat },
    shocks: [],
    trace: null,
    baseline: learning,
    ...overrides,
  };
}

describe('resolveObservation', () => {
  it('applies a confident complete observation', () => {
    const resolution = resolveObservation(input({ baseline: established }), rules);
    const profile = buildActivityProfile(steadyChat, rules);
    expect(resolution).toEqual({
      outcome: 'applied',
      profile,
      // 30 contributions against 20 +/- 7 is busier; burst 200 against 500.
      comparison: { band: 'busier', relativeIntensity: 1500, burstShift: -300 },
      score: scoreRound(
        {
          genome: { pulse: 6, calm: 8, grit: 6, drift: 4 },
          healthBefore: 70,
          profile,
          shocks: [],
          trace: null,
        },
        rules,
      ),
      healthBefore: 70,
      healthAfter: 70,
      extinct: false,
    });
  });

  it('changes health by the scored delta', () => {
    const bursty = observationsFromBuckets([13, 12, 12, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    const resolution = resolveObservation(
      input({
        healthBefore: 30,
        observation: { status: 'complete', observations: bursty },
        shocks: [arrivalShock(rules)],
      }),
      rules,
    );
    expect(resolution).toMatchObject({ outcome: 'applied', healthAfter: 28, extinct: false });
  });

  it('records extinction when health reaches zero', () => {
    const resolution = resolveObservation(
      input({
        genome: { pulse: 0, calm: 9, grit: 0, drift: 15 },
        healthBefore: 2,
        shocks: [arrivalShock(rules)],
      }),
      rules,
    );
    expect(resolution).toMatchObject({ outcome: 'applied', healthAfter: 0, extinct: true });
  });

  it('holds health and labels the estimate when too few accounts chatted', () => {
    const twoAccounts = observationsFromBuckets([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const resolution = resolveObservation(
      input({
        genome: { pulse: 0, calm: 9, grit: 0, drift: 15 },
        healthBefore: 2,
        observation: { status: 'complete', observations: twoAccounts },
        shocks: [arrivalShock(rules)],
      }),
      rules,
    );
    expect(resolution.outcome).toBe('limited');
    expect(resolution).toMatchObject({ healthBefore: 2, healthAfter: 2 });
    expect(resolution).not.toHaveProperty('extinct');
    if (resolution.outcome === 'limited') {
      expect(resolution.estimate.healthAfter).toBe(0);
      expect(resolution.profile.confidence).toBe('limited');
    }
  });

  it('treats a silent channel as limited, with a neutral profile', () => {
    const resolution = resolveObservation(
      input({ observation: { status: 'complete', observations: [] } }),
      rules,
    );
    expect(resolution).toMatchObject({
      outcome: 'limited',
      profile: { neutral: true, burst: 500, steadiness: 500 },
      healthAfter: 70,
    });
  });

  it('never scores an interrupted observation as a quiet one', () => {
    const resolution = resolveObservation(
      input({
        observation: { status: 'interrupted' },
        shocks: [arrivalShock(rules)],
        trace: 'charged',
      }),
      rules,
    );
    expect(resolution).toEqual({ outcome: 'interrupted', healthBefore: 70, healthAfter: 70 });
  });

  it('only changes health in an applied round', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 12, maxLength: 12 }),
        fc.integer({ min: 1, max: 100 }),
        fc.boolean(),
        (counts, healthBefore, interrupted) => {
          const resolution = resolveObservation(
            input({
              healthBefore,
              observation: interrupted
                ? { status: 'interrupted' }
                : { status: 'complete', observations: observationsFromBuckets(counts) },
              shocks: [arrivalShock(rules)],
            }),
            rules,
          );
          if (resolution.outcome === 'applied') {
            expect(resolution.healthAfter).toBe(resolution.score.healthAfter);
          } else {
            expect(resolution.healthAfter).toBe(healthBefore);
          }
        },
      ),
    );
  });

  it('validates its inputs even when interrupted', () => {
    const illegal: Genome = { pulse: 6, calm: 6, grit: 6, drift: 7 };
    expect(() =>
      resolveObservation(input({ genome: illegal, observation: { status: 'interrupted' } }), rules),
    ).toThrow(expect.objectContaining({ code: 'ILLEGAL_GENOME' }));
    expect(() =>
      resolveObservation(input({ healthBefore: 0, observation: { status: 'interrupted' } }), rules),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});
