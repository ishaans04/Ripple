import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isLegalGenome, type Genome } from './genome.ts';
import { arrivalShock, categoryChangeShock, type ShockMarker } from './habitat.ts';
import { candidateRuleset as rules, parseRuleset, rulesetCanonicalJson } from './ruleset.ts';
import { scoreRound, type ScoreInput, type TraceTemplate } from './scoring.ts';

function genome(pulse: number, calm: number, grit: number, drift: number): Genome {
  return { pulse, calm, grit, drift };
}

function profile(burst: number) {
  return { burst, steadiness: 1000 - burst };
}

function input(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    genome: genome(6, 8, 6, 4),
    healthBefore: 70,
    profile: profile(200),
    shocks: [],
    trace: null,
    ...overrides,
  };
}

function rulesWith(edit: (draft: Record<string, Record<string, unknown>>) => void) {
  const draft = JSON.parse(rulesetCanonicalJson(rules)) as Record<string, Record<string, unknown>>;
  edit(draft);
  return parseRuleset(draft);
}

const legalGenome = fc
  .tuple(fc.nat(15), fc.nat(15), fc.nat(15))
  .map(([pulse, calm, grit]) => genome(pulse, calm, grit, 24 - pulse - calm - grit))
  .filter((g) => isLegalGenome(g, rules.genome));

const shockMarkers = fc.array(
  fc.constantFrom<ShockMarker>(arrivalShock(rules), categoryChangeShock(rules)),
  { maxLength: 4 },
);

const traceTemplate = fc.constantFrom<TraceTemplate | null>(null, 'shelter', 'charged', 'recovery');

const anyInput = fc.record({
  genome: legalGenome,
  healthBefore: fc.integer({ min: 1, max: 100 }),
  profile: fc.integer({ min: 0, max: 1000 }).map(profile),
  shocks: shockMarkers,
  trace: traceTemplate,
});

describe('scoreRound', () => {
  it('scores source A after its mutation (worked journey)', () => {
    expect(scoreRound(input(), rules)).toEqual({
      genome: genome(6, 8, 6, 4),
      burst: 200,
      steadiness: 800,
      pulseTerm: 1200,
      calmTerm: 6400,
      fit: 3,
      upkeep: 3,
      arrivalShock: 0,
      categoryShock: 0,
      shelterReduction: 0,
      rawShock: 0,
      gritProtection: 3,
      shock: 0,
      trace: null,
      fitness: 0,
      rawDelta: 0,
      delta: 0,
      healthBefore: 70,
      healthAfter: 70,
      extinct: false,
    });
  });

  it('applies arrival shock less Grit protection (worked journey, B welcome)', () => {
    const score = scoreRound(
      input({ healthBefore: 30, profile: profile(900), shocks: [arrivalShock(rules)] }),
      rules,
    );
    expect(score).toMatchObject({
      fit: 2,
      arrivalShock: 4,
      rawShock: 4,
      gritProtection: 3,
      shock: 1,
      fitness: -2,
      delta: -2,
      healthAfter: 28,
    });
  });

  it('rounds habitat fit half up from exact integer terms', () => {
    // 6 * (8 * 900 + 6 * 100) / 15000 = 3.12 -> 3; 6 * (6 * 900 + 6 * 100) / 15000 = 2.4 -> 2.
    expect(
      scoreRound(input({ genome: genome(8, 6, 6, 4), profile: profile(900) }), rules).fit,
    ).toBe(3);
    expect(
      scoreRound(input({ genome: genome(6, 6, 6, 6), profile: profile(900) }), rules).fit,
    ).toBe(2);
    // 6 * (5 * 500 + 0 * 500) / 15000 = 1 exactly; 6 * (15 * 625) / 15000 = 3.75 -> 4.
    expect(
      scoreRound(input({ genome: genome(5, 0, 15, 4), profile: profile(500) }), rules).fit,
    ).toBe(1);
    expect(
      scoreRound(input({ genome: genome(15, 0, 0, 9), profile: profile(625) }), rules).fit,
    ).toBe(4);
    // 6 * (15 * 375) / 15000 = 2.25 -> 2.
    expect(
      scoreRound(input({ genome: genome(15, 0, 0, 9), profile: profile(375) }), rules).fit,
    ).toBe(2);
    // 6 * (7 * 625 + 5 * 375) / 15000 = 2.5 exactly -> 3 (half up, not to even).
    expect(
      scoreRound(input({ genome: genome(7, 5, 6, 6), profile: profile(625) }), rules).fit,
    ).toBe(3);
  });

  it.each([
    [genome(9, 15, 0, 0), 0],
    [genome(9, 14, 1, 0), 0],
    [genome(9, 13, 2, 0), 1],
    [genome(6, 6, 6, 6), 3],
    [genome(9, 0, 15, 0), 8],
  ])('gives %j a Grit protection of floor(8 * Grit / 15) = %i', (g, protection) => {
    expect(scoreRound(input({ genome: g }), rules).gritProtection).toBe(protection);
  });

  it('caps combined raw shock at 8', () => {
    const score = scoreRound(
      input({
        genome: genome(9, 15, 0, 0),
        shocks: [
          arrivalShock(rules),
          categoryChangeShock(rules),
          categoryChangeShock(rules),
          arrivalShock(rules),
        ],
      }),
      rules,
    );
    expect(score).toMatchObject({
      arrivalShock: 8,
      categoryShock: 4,
      rawShock: 8,
      gritProtection: 0,
      shock: 8,
    });
  });

  it('clamps a large loss to -8 and records extinction at zero health', () => {
    // Fit 0 in a fully bursty habitat with no Pulse and 8 unprotected shock. Recovery restores
    // 1 below health 30, but only to the delta: fitness -11, delta -10 clamped to -8.
    const score = scoreRound(
      input({
        genome: genome(0, 9, 0, 15),
        healthBefore: 8,
        profile: profile(1000),
        shocks: [arrivalShock(rules), arrivalShock(rules)],
        trace: 'recovery',
      }),
      rules,
    );
    expect(score).toMatchObject({
      fit: 0,
      shock: 8,
      fitness: -11,
      rawDelta: -10,
      delta: -8,
      healthAfter: 0,
      extinct: true,
    });
  });

  it('never lets health fall below zero', () => {
    const score = scoreRound(
      input({
        genome: genome(0, 9, 0, 15),
        healthBefore: 3,
        profile: profile(1000),
        shocks: [arrivalShock(rules)],
      }),
      rules,
    );
    expect(score).toMatchObject({ delta: -7, healthAfter: 0, extinct: true });
  });

  it('clamps a large gain and caps health at its maximum', () => {
    const generous = rulesWith((draft) => {
      draft.scoring!.fitWeight = 20;
    });
    const score = scoreRound(
      input({ genome: genome(15, 0, 0, 9), healthBefore: 97, profile: profile(1000) }),
      generous,
    );
    expect(score).toMatchObject({ fit: 20, rawDelta: 17, delta: 6, healthAfter: 100 });
  });

  describe('traces', () => {
    it.each([
      [650, 1],
      [649, -1],
      [900, 1],
    ])('Charged habitat at burst %i adjusts fitness by %i', (burst, amount) => {
      const score = scoreRound(input({ profile: profile(burst), trace: 'charged' }), rules);
      expect(score.trace).toEqual({ template: 'charged', effect: 'fitness', amount });
      expect(score.fitness).toBe(score.fit - 3 - score.shock + amount);
    });

    it.each([
      [29, 1],
      [30, -1],
    ])(
      'Recovery zone at start health %i adjusts the health delta by %i, not fitness',
      (healthBefore, amount) => {
        const score = scoreRound(input({ healthBefore, trace: 'recovery' }), rules);
        expect(score.trace).toEqual({ template: 'recovery', effect: 'health', amount });
        expect(score.fitness).toBe(0);
        expect(score.rawDelta).toBe(amount);
      },
    );

    it('Shelter removes 2 of an arrival shock and costs 1 upkeep', () => {
      const score = scoreRound(
        input({ genome: genome(9, 15, 0, 0), shocks: [arrivalShock(rules)], trace: 'shelter' }),
        rules,
      );
      expect(score).toMatchObject({
        arrivalShock: 2,
        shelterReduction: 2,
        rawShock: 2,
        shock: 2,
        trace: { template: 'shelter', effect: 'upkeep', amount: -1 },
      });
      expect(score.fitness).toBe(score.fit - 3 - 2 - 1);
    });

    it('Shelter does not reduce category-change shock', () => {
      const score = scoreRound(
        input({
          genome: genome(9, 15, 0, 0),
          shocks: [categoryChangeShock(rules)],
          trace: 'shelter',
        }),
        rules,
      );
      expect(score).toMatchObject({ categoryShock: 2, shelterReduction: 0, rawShock: 2 });
    });

    it('caps the net trace adjustment to the configured range', () => {
      const strong = rulesWith((draft) => {
        draft.traces!.chargedAdjustment = 3;
        draft.traces!.shelterUpkeep = 4;
      });
      expect(
        scoreRound(input({ profile: profile(900), trace: 'charged' }), strong).trace?.amount,
      ).toBe(1);
      expect(
        scoreRound(input({ profile: profile(100), trace: 'charged' }), strong).trace?.amount,
      ).toBe(-1);
      expect(scoreRound(input({ trace: 'shelter' }), strong).trace?.amount).toBe(-1);
    });
  });

  it('keeps delta and health within their bounds', () => {
    fc.assert(
      fc.property(anyInput, (scoreInput) => {
        const score = scoreRound(scoreInput, rules);
        expect(score.delta).toBeGreaterThanOrEqual(-8);
        expect(score.delta).toBeLessThanOrEqual(6);
        expect(score.healthAfter).toBe(
          Math.min(100, Math.max(0, score.healthBefore + score.delta)),
        );
        expect(score.extinct).toBe(score.healthAfter === 0);
        expect(Math.abs(score.trace?.amount ?? 0)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('never lets Grit increase damage', () => {
    fc.assert(
      fc.property(anyInput, (scoreInput) => {
        const score = scoreRound(scoreInput, rules);
        expect(score.shock).toBeLessThanOrEqual(score.rawShock);
        expect(score.rawShock).toBeLessThanOrEqual(8);
      }),
    );
  });

  it('scores fitness independently of start health', () => {
    fc.assert(
      fc.property(anyInput, fc.integer({ min: 1, max: 100 }), (scoreInput, otherHealth) => {
        expect(scoreRound({ ...scoreInput, healthBefore: otherHealth }, rules).fitness).toBe(
          scoreRound(scoreInput, rules).fitness,
        );
      }),
    );
  });

  it.each<[string, Partial<ScoreInput>, string]>([
    ['an illegal genome', { genome: genome(6, 6, 6, 7) }, 'ILLEGAL_GENOME'],
    ['zero start health', { healthBefore: 0 }, 'INVALID_ARGUMENT'],
    ['start health above the maximum', { healthBefore: 101 }, 'INVALID_ARGUMENT'],
    ['an unbalanced profile', { profile: { burst: 600, steadiness: 600 } }, 'INVALID_ARGUMENT'],
    ['a burst beyond the scale', { profile: { burst: 1001, steadiness: -1 } }, 'INVALID_ARGUMENT'],
    ['a negative shock', { shocks: [{ kind: 'arrival', amount: -1 }] }, 'INVALID_ARGUMENT'],
  ])('rejects %s', (_label, overrides, code) => {
    expect(() => scoreRound(input(overrides), rules)).toThrow(expect.objectContaining({ code }));
  });
});
