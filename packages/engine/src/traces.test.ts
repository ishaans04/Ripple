import { describe, expect, it } from 'vitest';
import type { Genome } from './genome.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import { qualifiesForTrace, traceTemplateFor, type TraceQualificationInput } from './traces.ts';

function genome(pulse: number, calm: number, grit: number, drift: number): Genome {
  return { pulse, calm, grit, drift };
}

describe('traceTemplateFor', () => {
  it.each([
    ['Pulse leads (worked journey)', genome(8, 6, 6, 4), 'charged'],
    ['Calm leads', genome(6, 8, 6, 4), 'recovery'],
    ['Grit leads', genome(6, 6, 8, 4), 'shelter'],
    ['Drift leads', genome(6, 6, 4, 8), 'recovery'],
    ['all genes tie, Pulse first', genome(6, 6, 6, 6), 'charged'],
    ['Calm ties Grit, Calm first', genome(5, 7, 7, 5), 'recovery'],
    ['Grit ties Drift, Grit first', genome(4, 6, 7, 7), 'shelter'],
    ['Pulse ties Drift, Pulse first', genome(9, 3, 3, 9), 'charged'],
  ] as const)('maps a genome where %s', (_label, g, template) => {
    expect(traceTemplateFor(g, rules)).toBe(template);
  });

  it('rejects an illegal genome', () => {
    expect(() => traceTemplateFor(genome(9, 9, 9, 9), rules)).toThrow(
      expect.objectContaining({ code: 'ILLEGAL_GENOME' }),
    );
  });
});

describe('qualifiesForTrace', () => {
  const journey: TraceQualificationInput = {
    raidOrigin: true,
    validSurvivingRounds: 2,
    qualifiedThisResidency: false,
    lineageQualifiedAtHostThisSeason: false,
  };

  it('qualifies a raid-origin visitor after two valid surviving rounds (worked journey)', () => {
    expect(qualifiesForTrace(journey, rules)).toBe(true);
  });

  it.each<[string, Partial<TraceQualificationInput>]>([
    ['one valid round', { validSurvivingRounds: 1 }],
    ['a founder at its own host', { raidOrigin: false }],
    ['a second qualification in the same residency', { qualifiedThisResidency: true }],
    [
      'a lineage that already qualified at this host this season',
      { lineageQualifiedAtHostThisSeason: true },
    ],
  ])('does not qualify %s', (_label, overrides) => {
    expect(qualifiesForTrace({ ...journey, ...overrides }, rules)).toBe(false);
  });

  it('rejects a negative round count', () => {
    expect(() => qualifiesForTrace({ ...journey, validSurvivingRounds: -1 }, rules)).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});
