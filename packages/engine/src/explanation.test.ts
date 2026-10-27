import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { freezeBaseline } from './baseline.ts';
import { explainResolution, formatSigned } from './explanation.ts';
import { isLegalGenome, type Genome } from './genome.ts';
import {
  arrivalShock,
  categoryChangeShock,
  type ActivityObservation,
  type ShockMarker,
} from './habitat.ts';
import { resolveObservation, type ResolutionInput } from './resolution.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import type { TraceTemplate } from './scoring.ts';

function observationsFromBuckets(counts: readonly number[]): ActivityObservation[] {
  return counts.flatMap((count, bucket) =>
    Array.from({ length: count }, (_, n) => ({
      actorKey: `actor-${n}`,
      offsetMs: bucket * 10_000,
    })),
  );
}

const steady = observationsFromBuckets([4, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2]); // burst 200
const bursty = observationsFromBuckets([13, 12, 12, 1, 1, 1, 0, 0, 0, 0, 0, 0]); // burst 900
const learning = freezeBaseline([], rules);

function explain(overrides: Partial<ResolutionInput>) {
  const input: ResolutionInput = {
    genome: { pulse: 6, calm: 8, grit: 6, drift: 4 },
    healthBefore: 70,
    observation: { status: 'complete', observations: steady },
    shocks: [],
    trace: null,
    baseline: learning,
    ...overrides,
  };
  return explainResolution(resolveObservation(input, rules), rules);
}

describe('explainResolution', () => {
  it('explains a round where habitat fit exactly covers upkeep (worked journey, source A)', () => {
    expect(explain({})).toEqual({
      headline: 'Energy held at 70',
      causes: [
        {
          component: 'habitat',
          amount: 0,
          text: 'Steady chat fed its Calm: fit 3 against upkeep 3',
        },
      ],
      contributions: [
        {
          component: 'habitat',
          amount: 0,
          text: 'Steady chat fed its Calm: fit 3 against upkeep 3',
        },
      ],
      calculation: [
        {
          label: 'Habitat fit',
          value: 3,
          formula: 'round(6 * (Pulse 6 * burst 200 + Calm 8 * steadiness 800) / 15000) = 3',
        },
        { label: 'Upkeep', value: 3, formula: 'upkeep = 3' },
        { label: 'Raw shock', value: 0, formula: 'min(8, arrival 0 + category 0) = 0' },
        { label: 'Grit protection', value: 3, formula: 'floor(8 * Grit 6 / 15) = 3' },
        { label: 'Shock', value: 0, formula: 'max(0, 0 - 3) = 0' },
        { label: 'Round fitness', value: 0, formula: 'fit 3 - upkeep 3 - shock 0 = 0' },
        { label: 'Energy change', value: 0, formula: 'clamp(0, -8, 6) = 0' },
        { label: 'Energy', value: 70, formula: 'clamp(70 + 0, 0, 100) = 70' },
      ],
      notes: ['Learning habitat: comparisons begin after 3 valid rounds.'],
    });
  });

  it('leads with the arrival shock and Grit protection (worked journey, B welcome)', () => {
    const explanation = explain({
      healthBefore: 30,
      observation: { status: 'complete', observations: bursty },
      shocks: [arrivalShock(rules)],
    });
    expect(explanation.headline).toBe('Lost 2 energy (30 to 28)');
    expect(explanation.causes).toEqual([
      { component: 'shock', amount: -4, text: 'Arrival shock hit for 4' },
      { component: 'grit', amount: 3, text: 'Grit blocked 3 of the shock' },
    ]);
    expect(explanation.contributions).toEqual([
      {
        component: 'habitat',
        amount: -1,
        text: 'Bursty chat fed its Pulse: fit 2 against upkeep 3',
      },
      { component: 'shock', amount: -4, text: 'Arrival shock hit for 4' },
      { component: 'grit', amount: 3, text: 'Grit blocked 3 of the shock' },
    ]);
  });

  it('credits an active trace as the decisive cause', () => {
    const explanation = explain({
      genome: { pulse: 8, calm: 6, grit: 6, drift: 4 },
      healthBefore: 28,
      observation: { status: 'complete', observations: bursty },
      trace: 'charged',
    });
    expect(explanation.headline).toBe('Gained 1 energy (28 to 29)');
    expect(explanation.causes).toEqual([
      { component: 'trace', amount: 1, text: 'Charged habitat added 1 in a bursty round' },
    ]);
    expect(explanation.calculation).toContainEqual({
      label: 'Trace',
      value: 1,
      formula: 'Charged habitat: burst 900 >= 650, +1',
    });
    expect(explanation.calculation).toContainEqual({
      label: 'Round fitness',
      value: 1,
      formula: 'fit 3 - upkeep 3 - shock 0 + trace 1 = 1',
    });
  });

  it.each<[TraceTemplate, Partial<ResolutionInput>, string, string]>([
    [
      'charged',
      {},
      'Charged habitat cost 1 in a steadier round',
      'Charged habitat: burst 200 < 650, -1',
    ],
    [
      'recovery',
      { healthBefore: 29 },
      'Recovery zone restored 1 at low energy',
      'Recovery zone: start energy 29 < 30, +1',
    ],
    [
      'recovery',
      {},
      'Recovery zone cost 1 above low energy',
      'Recovery zone: start energy 70 >= 30, -1',
    ],
    ['shelter', {}, 'Shelter trace upkeep cost 1', 'Shelter: upkeep -1'],
  ])('words a %s trace', (trace, overrides, text, formula) => {
    const explanation = explain({ trace, ...overrides });
    expect(explanation.contributions).toContainEqual(
      expect.objectContaining({ component: 'trace', text }),
    );
    expect(explanation.calculation).toContainEqual(
      expect.objectContaining({ label: 'Trace', formula }),
    );
  });

  it('shows the Shelter reduction in the raw shock calculation', () => {
    const explanation = explain({ shocks: [arrivalShock(rules)], trace: 'shelter' });
    expect(explanation.calculation).toContainEqual({
      label: 'Raw shock',
      value: 2,
      formula: 'min(8, arrival 4 - Shelter 2 + category 0) = 2',
    });
  });

  it.each<[ShockMarker[], number, string]>([
    [[categoryChangeShock(rules)], -2, 'A category change shook the habitat for 2'],
    [
      [arrivalShock(rules), categoryChangeShock(rules)],
      -6,
      'Arrival and category-change shocks hit for 6',
    ],
  ])('words shock markers %j', (shocks, amount, text) => {
    expect(explain({ shocks }).contributions).toContainEqual({ component: 'shock', amount, text });
  });

  it('reports a clamped loss and extinction', () => {
    const explanation = explain({
      genome: { pulse: 0, calm: 9, grit: 0, drift: 15 },
      healthBefore: 8,
      observation: { status: 'complete', observations: bursty },
      shocks: [arrivalShock(rules), arrivalShock(rules)],
    });
    // Fit 0 (6 * 9 * 100 / 15000 = 0.36): habitat -3, shock -8, raw delta -11 clamped to -8.
    expect(explanation.headline).toBe('Energy fell to 0: this branch becomes a fossil');
    expect(explanation.contributions).toContainEqual({
      component: 'limit',
      amount: 3,
      text: 'The round loss was limited to 8',
    });
    expect(explanation.calculation).toContainEqual({
      label: 'Energy change',
      value: -8,
      formula: 'clamp(-11, -8, 6) = -8',
    });
  });

  it('labels a limited estimate and holds energy', () => {
    const twoAccounts = observationsFromBuckets([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const explanation = explain({ observation: { status: 'complete', observations: twoAccounts } });
    expect(explanation.headline).toBe('Too little chat to judge this round: energy stays at 70');
    expect(explanation.notes).toContain(
      'Estimate only: fewer than 3 accounts chatted, so energy is held. The estimate was +0.',
    );
  });

  it('says when nobody chatted at all', () => {
    const explanation = explain({ observation: { status: 'complete', observations: [] } });
    expect(explanation.notes).toContain('Nobody chatted during the observation.');
  });

  it('explains an interrupted round without inventing numbers', () => {
    expect(explain({ observation: { status: 'interrupted' } })).toEqual({
      headline: 'Observation interrupted: energy stays at 70',
      causes: [],
      contributions: [],
      calculation: [],
      notes: ['This round does not count toward traces, contests, or the habitat baseline.'],
    });
  });

  it('compares activity with an established baseline', () => {
    const established = freezeBaseline(
      [
        { roundId: 'r1', contributions: 10, burst: 200, confidence: 'confident' },
        { roundId: 'r2', contributions: 20, burst: 400, confidence: 'confident' },
        { roundId: 'r3', contributions: 30, burst: 900, confidence: 'confident' },
      ],
      rules,
    );
    expect(explain({ baseline: established }).notes).toEqual(['Chat was busier than usual.']);
  });

  describe('for any applied or limited round', () => {
    const legalGenome = fc
      .tuple(fc.nat(15), fc.nat(15), fc.nat(15))
      .map(([pulse, calm, grit]): Genome => ({
        pulse,
        calm,
        grit,
        drift: 24 - pulse - calm - grit,
      }))
      .filter((g) => isLegalGenome(g, rules.genome));
    const anyInput = fc.record({
      genome: legalGenome,
      healthBefore: fc.integer({ min: 1, max: 100 }),
      counts: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 12, maxLength: 12 }),
      shocks: fc.array(fc.constantFrom(arrivalShock(rules), categoryChangeShock(rules)), {
        maxLength: 3,
      }),
      trace: fc.constantFrom<TraceTemplate | null>(null, 'shelter', 'charged', 'recovery'),
    });

    it('lists contributions that sum exactly to the energy change and at most two causes among them', () => {
      fc.assert(
        fc.property(anyInput, ({ genome, healthBefore, counts, shocks, trace }) => {
          const resolution = resolveObservation(
            {
              genome,
              healthBefore,
              observation: { status: 'complete', observations: observationsFromBuckets(counts) },
              shocks,
              trace,
              baseline: learning,
            },
            rules,
          );
          if (resolution.outcome === 'interrupted') {
            return;
          }
          const score = resolution.outcome === 'applied' ? resolution.score : resolution.estimate;
          const explanation = explainResolution(resolution, rules);
          expect(explanation.contributions.reduce((sum, line) => sum + line.amount, 0)).toBe(
            score.delta,
          );
          expect(explanation.causes.length).toBeGreaterThanOrEqual(1);
          expect(explanation.causes.length).toBeLessThanOrEqual(2);
          for (const cause of explanation.causes) {
            expect(explanation.contributions).toContainEqual(cause);
          }
          const magnitudes = explanation.contributions.map((line) => Math.abs(line.amount));
          if (explanation.causes[0]!.amount !== 0) {
            expect(Math.abs(explanation.causes[0]!.amount)).toBe(Math.max(...magnitudes));
          }
        }),
      );
    });
  });
});

describe('formatSigned', () => {
  it.each([
    [3, '+3'],
    [-4, '-4'],
    [0, '+0'],
  ])('formats %i as %s', (value, text) => {
    expect(formatSigned(value)).toBe(text);
  });
});
