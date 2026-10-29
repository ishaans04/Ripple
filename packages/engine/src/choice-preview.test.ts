import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { previewMutationChoices } from './choice-preview.ts';
import { describeMove, generateMutationCandidates, type MutationCandidate } from './candidates.ts';
import { applyMove, isLegalGenome, moveId, type Genome, type MutationMove } from './genome.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import type { TraceTemplate } from './scoring.ts';

const genome: Genome = { pulse: 6, calm: 6, grit: 6, drift: 6 };
const moves: MutationMove[] = [
  { from: 'pulse', to: 'grit', amount: 2 },
  { from: 'grit', to: 'pulse', amount: 2 },
  { from: 'drift', to: 'calm', amount: 2 },
];
const candidates: MutationCandidate[] = moves.map((move) => ({
  id: moveId(move),
  move,
  genome: applyMove(genome, move, rules.genome)!,
  ...describeMove(move),
  source: 'generated',
}));
const legalGenome = fc
  .tuple(fc.nat(15), fc.nat(15), fc.nat(15))
  .map(([pulse, calm, grit]): Genome => ({ pulse, calm, grit, drift: 24 - pulse - calm - grit }))
  .filter((g) => isLegalGenome(g, rules.genome));
describe('recent-profile mutation previews', () => {
  it('shows learning instead of inventing a profile or future score', () => {
    expect(
      previewMutationChoices(
        { genome, healthBefore: 70, candidates, recent: null, trace: null },
        rules,
      ),
    ).toMatchObject({ status: 'learning', reason: 'No valid habitat profile yet', cards: [] });
  });
  it('labels fixed recent activity, applies a known trace cost and keeps the stated gene trade-off', () => {
    const preview = previewMutationChoices(
      {
        genome,
        healthBefore: 100,
        candidates,
        recent: { roundId: 'prior-valid-round', profile: { burst: 1000, steadiness: 0 } },
        trace: 'recovery',
      },
      rules,
    );
    expect(preview.status).toBe('estimate');
    if (preview.status !== 'estimate') throw new Error('Expected a recent-profile estimate');
    expect(preview.label).toBe('Based on recent activity');
    expect(preview.uncertainty).toContain('future chat');
    expect(preview.sourceRoundId).toBe('prior-valid-round');
    expect(preview.hold.healthAfter).toBe(98);
    expect(preview.cards[1]).toMatchObject({
      candidateId: 'pulse+2/grit-2',
      tradeOff: 'Thinner shell',
      estimatedFitness: 0,
      estimatedEnergyChange: -1,
      relativeToHold: 1,
    });
  });
  it('uses final energy clamps and never mutates the current genome or recorded profile', () => {
    fc.assert(
      fc.property(
        legalGenome,
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.constantFrom<TraceTemplate | null>(null, 'shelter', 'charged', 'recovery'),
        (before, health, burst, trace) => {
          const cards = generateMutationCandidates(
            { seed: 'preview', roundId: 'next', genome: before },
            rules,
          );
          const input = {
            genome: before,
            healthBefore: health,
            candidates: cards,
            recent: { roundId: 'known', profile: { burst, steadiness: 1000 - burst } },
            trace,
          };
          const saved = structuredClone(input),
            preview = previewMutationChoices(input, rules);
          expect(input).toEqual(saved);
          if (preview.status !== 'estimate') throw new Error('Expected a known-profile estimate');
          for (const card of preview.cards) {
            expect(Number.isSafeInteger(card.estimatedEnergyChange)).toBe(true);
            expect(card.estimatedEnergyChange).toBeGreaterThanOrEqual(-health);
            expect(card.estimatedEnergyChange).toBeLessThanOrEqual(100 - health);
            expect(card.relativeToHold).toBe(
              card.estimatedEnergyChange - (preview.hold.healthAfter - health),
            );
          }
        },
      ),
      { numRuns: 300 },
    );
    const full: Genome = { pulse: 15, calm: 0, grit: 3, drift: 6 };
    const preview = previewMutationChoices(
      {
        genome: full,
        healthBefore: 100,
        candidates: generateMutationCandidates(
          { seed: 'max', roundId: 'known', genome: full },
          rules,
        ),
        recent: { roundId: 'prior', profile: { burst: 1000, steadiness: 0 } },
        trace: 'charged',
      },
      rules,
    );
    expect(preview.cards.every((card) => card.estimatedEnergyChange === 0)).toBe(true);
  });
  it('rejects malformed cards even without history and refuses an unrecorded profile source', () => {
    expect(() =>
      previewMutationChoices(
        {
          genome,
          healthBefore: 70,
          candidates: [candidates[0]!, candidates[0]!, candidates[2]!],
          recent: null,
          trace: null,
        },
        rules,
      ),
    ).toThrow();
    expect(() =>
      previewMutationChoices(
        {
          genome,
          healthBefore: 70,
          candidates,
          recent: { roundId: '', profile: { burst: 500, steadiness: 500 } },
          trace: null,
        },
        rules,
      ),
    ).toThrow();
  });
});
