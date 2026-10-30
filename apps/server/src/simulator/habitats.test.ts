import { describe, expect, it } from 'vitest';
import { buildActivityProfile, candidateRuleset, generateMutationCandidates } from '@ripple/engine';
import { habitats, observationsFor, tuningSeeds, heldOutSeeds } from './habitats.ts';
import { chooseCard, policies } from './policies.ts';

describe('recorded simulator habitats and policy information boundaries', () => {
  it('keeps evaluation seeds disjoint and profiles invariant to normalized audience size', () => {
    expect(tuningSeeds.some((seed) => heldOutSeeds.includes(seed))).toBe(false);
    for (const habitat of habitats)
      for (const round of [0, 4, 8]) {
        const small = buildActivityProfile(
          observationsFor(habitat, 'fixture', round, 'small'),
          candidateRuleset,
        );
        const large = buildActivityProfile(
          observationsFor(habitat, 'fixture', round, 'large'),
          candidateRuleset,
        );
        expect(small.burst).toBe(large.burst);
        expect(small.confidence).toBe(habitat === 'sparse' ? 'limited' : 'confident');
      }
  });
  it('generates distinct steady, bursty and changing habitats while spam adds no activity', () => {
    const profile = (habitat: (typeof habitats)[number], round = 0) =>
      buildActivityProfile(observationsFor(habitat, 'fixture', round, 'small'), candidateRuleset);
    expect(profile('steady').burst).toBe(0);
    expect(profile('bursty').burst).toBe(1000);
    expect(profile('shifting', 0).burst).not.toBe(profile('shifting', 4).burst);
    expect(profile('hostile-input')).toEqual(profile('steady'));
  });
  it('policies choose only offered cards, use deterministic ties and cannot inspect future data', () => {
    const cards = generateMutationCandidates(
      { seed: 'fixture', roundId: '1', genome: candidateRuleset.genome.founder },
      candidateRuleset,
    );
    for (const policy of policies) {
      const card = chooseCard(policy, cards, null, 'fixture', 1, candidateRuleset);
      expect(cards).toContain(card);
      expect(chooseCard(policy, cards, null, 'fixture', 1, candidateRuleset)).toEqual(card);
    }
    expect(() => chooseCard('seeded-random', [], null, 'fixture', 1, candidateRuleset)).toThrow();
  });
});
