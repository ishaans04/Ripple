import {
  generatorFromSeedMaterial,
  scoreRound,
  type Genome,
  type HabitatProfile,
  type MutationCandidate,
  type Ruleset,
} from '@ripple/engine';

export const policies = [
  'always-Pulse',
  'always-Calm',
  'defensive',
  'migration-focused',
  'seeded-random',
  'recent-profile-informed',
] as const;
export type Policy = (typeof policies)[number];
/** Only offered cards and the previous known profile are visible to a policy. */
export function chooseCard(
  policy: Policy,
  cards: readonly MutationCandidate[],
  previous: HabitatProfile | null,
  seed: string,
  round: number,
  rules: Ruleset,
): MutationCandidate {
  const rng = generatorFromSeedMaterial({ purpose: 'policy-v1', policy, seed, round });
  if (cards.length === 0) throw new Error('A policy needs at least one offered card.');
  if (policy === 'seeded-random')
    return cards[rng.nextInt(cards.length)] ?? cards.reduce((first) => first);
  const value = (genome: Genome) => {
    switch (policy) {
      case 'always-Pulse':
        return genome.pulse;
      case 'always-Calm':
        return genome.calm;
      case 'defensive':
        return genome.grit;
      case 'migration-focused':
        return genome.drift;
      case 'recent-profile-informed':
        return previous === null
          ? 0
          : scoreRound(
              { genome, healthBefore: 70, profile: previous, shocks: [], trace: null },
              rules,
            ).fitness;
    }
  };
  // Seeded card order breaks ties. Policies cannot invent a move or Hold option.
  return cards.reduce((best, card) => (value(card.genome) > value(best.genome) ? card : best));
}
