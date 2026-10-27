import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  arrivalShock,
  buildActivityProfile,
  categoryChangeShock,
  type ActivityObservation,
} from './habitat.ts';
import { candidateRuleset as rules } from './ruleset.ts';

/** Bucket i gets counts[i] distinct accounts, each speaking once, 3 seconds into the bucket. */
function observationsFromBuckets(
  counts: readonly number[],
  prefix = 'actor',
): ActivityObservation[] {
  return counts.flatMap((count, bucket) =>
    Array.from({ length: count }, (_, n) => ({
      actorKey: `${prefix}-${n}`,
      offsetMs: bucket * 10_000 + 3_000,
    })),
  );
}

/** The PRD formula, computed independently with BigInt. */
function prdBurst(counts: readonly number[]): number {
  const m = BigInt(counts.reduce((sum, n) => sum + n, 0));
  const q = BigInt(
    [...counts]
      .sort((a, b) => b - a)
      .slice(0, 3)
      .reduce((sum, n) => sum + n, 0),
  );
  // round_half_up(x / y) = floor((2x + y) / 2y) for y > 0; x >= 0 here.
  const x = 1000n * (4n * q - m);
  const y = 3n * m;
  const rounded = Number((2n * x + y) / (2n * y));
  return Math.min(1000, Math.max(0, rounded));
}

const bucketCounts = fc
  .array(fc.integer({ min: 0, max: 6 }), { minLength: 12, maxLength: 12 })
  .filter((counts) => counts.some((n) => n > 0));

describe('buildActivityProfile', () => {
  it('measures a steady habitat (worked journey, source A)', () => {
    const profile = buildActivityProfile(
      observationsFromBuckets([4, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2]),
      rules,
    );
    expect(profile).toEqual({
      bucketCounts: [4, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2],
      contributions: 30,
      topBucketContributions: 12,
      distinctAccounts: 4,
      burst: 200,
      steadiness: 800,
      neutral: false,
      confidence: 'confident',
    });
  });

  it('measures a bursty habitat (worked journey, host B)', () => {
    const profile = buildActivityProfile(
      observationsFromBuckets([13, 12, 12, 1, 1, 1, 0, 0, 0, 0, 0, 0]),
      rules,
    );
    expect(profile).toMatchObject({
      contributions: 40,
      topBucketContributions: 37,
      burst: 900,
      steadiness: 100,
    });
  });

  it.each([
    ['everything in one bucket', [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 1000],
    ['everything in three buckets', [0, 2, 0, 0, 7, 0, 0, 0, 1, 0, 0, 0], 1000],
    ['perfectly even chat', [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3], 0],
    ['m = 10, q = 4: 1000 * 6 / 30', [2, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0], 200],
    // m = 64, q = 19: 1000 * 12 / 192 = 62.5 exactly, which rounds half up to 63.
    ['an exact half', [7, 6, 6, 5, 5, 5, 5, 5, 5, 5, 5, 5], 63],
  ])('scores %s', (_label, counts, burst) => {
    expect(buildActivityProfile(observationsFromBuckets(counts), rules).burst).toBe(burst);
  });

  it('matches the PRD formula for any non-empty observation', () => {
    fc.assert(
      fc.property(bucketCounts, (counts) => {
        const profile = buildActivityProfile(observationsFromBuckets(counts), rules);
        expect(profile.burst).toBe(prdBurst(counts));
        expect(profile.steadiness).toBe(1000 - profile.burst);
      }),
    );
  });

  it('is independent of raw channel volume', () => {
    fc.assert(
      fc.property(bucketCounts, fc.integer({ min: 2, max: 5 }), (counts, scale) => {
        const small = buildActivityProfile(observationsFromBuckets(counts), rules);
        const large = buildActivityProfile(
          observationsFromBuckets(counts.map((n) => n * scale)),
          rules,
        );
        expect(large.burst).toBe(small.burst);
      }),
    );
  });

  it('counts an account at most once per 10-second bucket', () => {
    const spam = Array.from({ length: 50 }, (_, n) => ({ actorKey: 'spammer', offsetMs: n * 100 }));
    const profile = buildActivityProfile(spam, rules);
    expect(profile.contributions).toBe(1);
    expect(profile.bucketCounts[0]).toBe(1);
  });

  it('counts the same account once in each bucket it speaks in', () => {
    const profile = buildActivityProfile(
      [
        { actorKey: 'a', offsetMs: 9_999 },
        { actorKey: 'a', offsetMs: 10_000 },
        { actorKey: 'a', offsetMs: 119_999 },
      ],
      rules,
    );
    expect(profile.bucketCounts).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(profile).toMatchObject({ contributions: 3, distinctAccounts: 1 });
  });

  it('uses a neutral display value with limited confidence when nobody chatted', () => {
    expect(buildActivityProfile([], rules)).toEqual({
      bucketCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      contributions: 0,
      topBucketContributions: 0,
      distinctAccounts: 0,
      burst: 500,
      steadiness: 500,
      neutral: true,
      confidence: 'limited',
    });
  });

  it('requires three distinct accounts for confidence', () => {
    const two = observationsFromBuckets([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(buildActivityProfile(two, rules).confidence).toBe('limited');
    const three = [...two, { actorKey: 'third', offsetMs: 0 }];
    expect(buildActivityProfile(three, rules).confidence).toBe('confident');
  });

  it.each([-1, 120_000, 1.5])('rejects an observation at offset %d', (offsetMs) => {
    expect(() => buildActivityProfile([{ actorKey: 'a', offsetMs }], rules)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });

  it('rejects an observation without an account key', () => {
    expect(() => buildActivityProfile([{ actorKey: '', offsetMs: 0 }], rules)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});

describe('shock markers', () => {
  it('records the configured arrival and category-change shocks', () => {
    expect(arrivalShock(rules)).toEqual({ kind: 'arrival', amount: 4 });
    expect(categoryChangeShock(rules)).toEqual({ kind: 'category_change', amount: 2 });
  });
});
