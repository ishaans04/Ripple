import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Genome } from './genome.ts';
import { childArrivalHealth } from './migration.ts';
import { candidateRuleset as rules, parseRuleset, rulesetCanonicalJson } from './ruleset.ts';

function withDrift(drift: number): Genome {
  // Any legal genome works; Drift is the only gene the formula reads.
  const rest = 24 - drift;
  const pulse = Math.min(15, rest);
  return { pulse, calm: rest - pulse, grit: 0, drift };
}

describe('childArrivalHealth', () => {
  it.each([
    // floor(70 * (350 + 20 * 4) / 1000) = floor(30.1) = 30 (worked journey).
    [70, 4, 30],
    // floor(70 * 350 / 1000) = 24.5 -> 24.
    [70, 0, 24],
    // floor(70 * 650 / 1000) = 45.
    [70, 15, 45],
    // floor(100 * 650 / 1000) = 65.
    [100, 15, 65],
    // floor(20 * 350 / 1000) = 7, raised to the minimum of 10.
    [20, 0, 10],
    // floor(29 * 350 / 1000) = 10.15 -> 10, exactly the minimum.
    [29, 0, 10],
  ])('a parent at health %i with Drift %i sends a child at %i', (parentHealth, drift, expected) => {
    expect(childArrivalHealth(parentHealth, withDrift(drift), rules)).toBe(expected);
  });

  it('caps the child at maximum health', () => {
    const draft = JSON.parse(rulesetCanonicalJson(rules)) as Record<
      string,
      Record<string, unknown>
    >;
    draft.migration!.retentionBasePermille = 1200;
    expect(childArrivalHealth(100, withDrift(0), parseRuleset(draft))).toBe(100);
  });

  it('stays within [minimum child health, maximum] and never falls as Drift rises', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 14 }),
        (health, drift) => {
          const lower = childArrivalHealth(health, withDrift(drift), rules);
          const higher = childArrivalHealth(health, withDrift(drift + 1), rules);
          expect(lower).toBeGreaterThanOrEqual(10);
          expect(higher).toBeLessThanOrEqual(100);
          expect(higher).toBeGreaterThanOrEqual(lower);
        },
      ),
    );
  });

  it('rejects a dead parent and an illegal genome', () => {
    expect(() => childArrivalHealth(0, withDrift(4), rules)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => childArrivalHealth(70, { pulse: 6, calm: 6, grit: 6, drift: 7 }, rules)).toThrow(
      expect.objectContaining({ code: 'ILLEGAL_GENOME' }),
    );
  });
});
