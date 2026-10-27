import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareToBaseline, freezeBaseline, type BaselineRound } from './baseline.ts';
import { candidateRuleset as rules } from './ruleset.ts';

function round(
  id: string,
  contributions: number,
  burst: number,
  confidence: BaselineRound['confidence'] = 'confident',
): BaselineRound {
  return { roundId: id, contributions, burst, confidence };
}

describe('freezeBaseline', () => {
  it('is learning until three valid rounds exist', () => {
    expect(freezeBaseline([round('r1', 10, 200), round('r2', 20, 400)], rules)).toEqual({
      status: 'learning',
      roundIds: ['r1', 'r2'],
      intensity: null,
      intensitySpread: null,
      burst: null,
    });
  });

  it('summarizes intensity, spread, and burst once established', () => {
    // Mean 20; mean absolute deviation (10 + 0 + 10) / 3 = 6.67 -> 7; mean burst 500.
    expect(
      freezeBaseline([round('r1', 10, 200), round('r2', 20, 400), round('r3', 30, 900)], rules),
    ).toEqual({
      status: 'established',
      roundIds: ['r1', 'r2', 'r3'],
      intensity: 20,
      intensitySpread: 7,
      burst: 500,
    });
  });

  it('uses only the last ten valid rounds', () => {
    // Round rN has N + 3 contributions, so r3..r12 hold 6..15.
    const history = Array.from({ length: 12 }, (_, n) => round(`r${n + 1}`, n + 4, 100));
    const baseline = freezeBaseline(history, rules);
    expect(baseline.roundIds).toEqual([
      'r3',
      'r4',
      'r5',
      'r6',
      'r7',
      'r8',
      'r9',
      'r10',
      'r11',
      'r12',
    ]);
    // Mean of 6..15 = 10.5, rounded half up.
    expect(baseline.intensity).toBe(11);
  });

  it('ignores limited-confidence rounds', () => {
    const baseline = freezeBaseline(
      [
        round('r1', 10, 200),
        round('quiet', 1, 1000, 'limited'),
        round('r2', 20, 400),
        round('quiet2', 2, 0, 'limited'),
      ],
      rules,
    );
    expect(baseline).toMatchObject({ status: 'learning', roundIds: ['r1', 'r2'] });
  });

  it('keeps its intensity within the range of its input rounds', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            m: fc.integer({ min: 3, max: 500 }),
            burst: fc.integer({ min: 0, max: 1000 }),
          }),
          {
            minLength: 3,
            maxLength: 15,
          },
        ),
        (rows) => {
          const history = rows.map((row, n) => round(`r${n}`, row.m, row.burst));
          const baseline = freezeBaseline(history, rules);
          const window = rows.slice(-10);
          const ms = window.map((row) => row.m);
          const bursts = window.map((row) => row.burst);
          expect(baseline.intensity).toBeGreaterThanOrEqual(Math.min(...ms));
          expect(baseline.intensity).toBeLessThanOrEqual(Math.max(...ms));
          expect(baseline.burst).toBeGreaterThanOrEqual(Math.min(...bursts));
          expect(baseline.burst).toBeLessThanOrEqual(Math.max(...bursts));
        },
      ),
    );
  });

  it.each([
    ['an empty round id', round('', 10, 200)],
    ['negative contributions', round('r', -1, 200)],
    ['a burst above the profile scale', round('r', 10, 1001)],
    ['a confident round with fewer contributions than accounts needed', round('r', 2, 200)],
  ])('rejects %s', (_label, bad) => {
    expect(() => freezeBaseline([bad], rules)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});

describe('compareToBaseline', () => {
  const established = freezeBaseline(
    [round('r1', 10, 200), round('r2', 20, 400), round('r3', 30, 900)],
    rules,
  );

  it('reports a neutral comparison while learning', () => {
    const learning = freezeBaseline([round('r1', 10, 200)], rules);
    expect(compareToBaseline({ contributions: 90, burst: 950 }, learning)).toEqual({
      band: 'learning',
      relativeIntensity: 1000,
      burstShift: 0,
    });
  });

  it.each([
    [12, 'quieter'],
    [13, 'typical'],
    [27, 'typical'],
    [28, 'busier'],
  ] as const)('places %i contributions against 20 +/- 7 as %s', (contributions, band) => {
    expect(compareToBaseline({ contributions, burst: 500 }, established).band).toBe(band);
  });

  it('expresses intensity in permille of the baseline and burst as a signed shift', () => {
    expect(compareToBaseline({ contributions: 30, burst: 350 }, established)).toEqual({
      band: 'busier',
      relativeIntensity: 1500,
      burstShift: -150,
    });
  });
});
