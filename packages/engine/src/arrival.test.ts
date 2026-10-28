import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { candidateRuleset } from './ruleset.ts';
import {
  prepareArrival,
  preparationOptions,
  resolveSpecialVote,
  resolveVisitorContest,
  welcomeArrival,
  welcomeOptions,
} from './arrival.ts';
describe('finite travel, welcome and contest rules', () => {
  it('captures standing preparation and defaults empty special ballots without changing genes', () => {
    expect(
      prepareArrival(70, { pulse: 6, calm: 6, grit: 6, drift: 6 }, 'neutral', candidateRuleset),
    ).toEqual({ health: 32, spent: 0, shockReduction: 0 });
    expect(
      prepareArrival(70, { pulse: 6, calm: 6, grit: 6, drift: 6 }, 'shield', candidateRuleset),
    ).toEqual({ health: 28, spent: 4, shockReduction: 2 });
    expect(resolveSpecialVote(preparationOptions, [], 'neutral').choice).toBe('neutral');
    expect(resolveSpecialVote(welcomeOptions(null), [], 'conserve').choice).toBe('conserve');
    expect(welcomeOptions(49).map((o) => o.id)).toEqual(['acclimate', 'conserve']);
    expect(welcomeOptions(50).map((o) => o.id)).toContain('shelter');
  });
  it('never spends below one health or duplicates shelter energy', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        (residentHealth, visitorHealth) => {
          const result = resolveVisitorContest({
            confidence: 'confident',
            residentHealth,
            visitorHealth,
            residentFitness: 0,
            visitorFitness: 20,
            shelterPending: true,
          });
          expect(result.residentHealth! + result.visitorHealth).toBe(
            residentHealth + visitorHealth,
          );
          expect(result.residentHealth).toBeGreaterThanOrEqual(1);
          expect(result.visitorHealth).toBeLessThanOrEqual(100);
          expect(result.moved).toBeLessThanOrEqual(5);
          expect(
            welcomeArrival(visitorHealth, 'acclimate', 0, candidateRuleset).health,
          ).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 1000 },
    );
  });
  it('holds shelter through limited/interrupted data, then defers exactly one valid contest', () => {
    const input = {
      residentHealth: 60,
      visitorHealth: 20,
      residentFitness: 0,
      visitorFitness: 2,
      shelterPending: true,
    };
    expect(resolveVisitorContest({ ...input, confidence: 'limited' })).toMatchObject({
      outcome: 'held',
      shelterPending: true,
      moved: 0,
    });
    expect(resolveVisitorContest({ ...input, confidence: 'interrupted' })).toMatchObject({
      outcome: 'held',
      shelterPending: true,
    });
    const sheltered = resolveVisitorContest({ ...input, confidence: 'confident' });
    expect(sheltered).toMatchObject({
      outcome: 'sheltered',
      residentHealth: 55,
      visitorHealth: 25,
      shelterPending: false,
      moved: 5,
    });
    expect(resolveVisitorContest({ ...input, ...sheltered, confidence: 'confident' }).outcome).toBe(
      'visitor',
    );
    expect(
      resolveVisitorContest({
        ...input,
        confidence: 'confident',
        shelterPending: false,
        visitorFitness: 0,
      }).outcome,
    ).toBe('resident');
  });
  it('applies extinction before contest and never lets inherited health win a fitness tie', () => {
    const input = {
      confidence: 'confident' as const,
      residentHealth: 1,
      visitorHealth: 100,
      residentFitness: 0,
      visitorFitness: 0,
      shelterPending: false,
    };
    expect(resolveVisitorContest(input).outcome).toBe('resident');
    expect(
      resolveVisitorContest({ ...input, visitorHealth: 0, shelterPending: true }).outcome,
    ).toBe('resident');
    expect(resolveVisitorContest({ ...input, residentHealth: 0, visitorHealth: 0 }).outcome).toBe(
      'empty',
    );
    expect(resolveVisitorContest({ ...input, residentHealth: 0 }).outcome).toBe('visitor');
  });
});
