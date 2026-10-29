import { z } from 'zod';
import { childArrivalHealth } from './migration.ts';
import { candidateRaidPolicy, type RaidPolicy } from './admission.ts';
import { assertLivingHealth } from './scoring.ts';
import type { Genome } from './genome.ts';
import type { Ruleset } from './ruleset.ts';
import { tallyVotes, type BallotVote } from './tally.ts';

export const preparationSchema = z.enum(['shield', 'reserve', 'neutral']);
export type TravelPreparation = z.infer<typeof preparationSchema>;
export const welcomeChoiceSchema = z.enum(['acclimate', 'conserve', 'shelter']);
export type WelcomeChoice = z.infer<typeof welcomeChoiceSchema>;
export const traceChoiceSchema = z.enum(['keep', 'clear']);
export type TraceChoice = z.infer<typeof traceChoiceSchema>;
export type SpecialChoice = TravelPreparation | WelcomeChoice | TraceChoice;
export function prepareArrival(
  parentHealth: number,
  genome: Genome,
  preparation: TravelPreparation,
  rules: Ruleset,
  policy: RaidPolicy = candidateRaidPolicy,
): { health: number; spent: number; shockReduction: number } {
  preparationSchema.parse(preparation);
  const retained = childArrivalHealth(parentHealth, genome, rules);
  const spent = preparation === 'shield' ? Math.min(policy.shieldCost, retained - 1) : 0;
  return {
    health: retained - spent,
    spent,
    shockReduction: spent > 0 ? policy.shieldShockReduction : 0,
  };
}
export interface SpecialOption {
  readonly id: SpecialChoice;
  readonly effect: string;
  readonly tradeOff: string;
}
export const preparationOptions: readonly SpecialOption[] = Object.freeze([
  {
    id: 'shield',
    effect: 'Shield the next descendant',
    tradeOff: 'Spend up to four child energy for two less arrival raw shock',
  },
  {
    id: 'reserve',
    effect: 'Keep a travel reserve',
    tradeOff: 'Retain finite arrival energy without extra protection',
  },
  {
    id: 'neutral',
    effect: 'Travel neutral',
    tradeOff: 'Use the standard inherited arrival energy and shock',
  },
]);
export const traceOptions: readonly SpecialOption[] = Object.freeze([
  {
    id: 'keep',
    effect: 'Keep this habitat trace',
    tradeOff: 'Replace any active trace for three valid observations',
  },
  {
    id: 'clear',
    effect: 'Clear this offer',
    tradeOff: 'Discard the offered trace; an existing trace keeps its own lifetime',
  },
]);
export function welcomeOptions(
  residentHealth: number | null,
  policy: RaidPolicy = candidateRaidPolicy,
): readonly SpecialOption[] {
  const choices: SpecialOption[] = [
    {
      id: 'acclimate',
      effect: 'Acclimate',
      tradeOff: 'Spend up to four visitor energy for one less arrival raw shock',
    },
    {
      id: 'conserve',
      effect: 'Conserve',
      tradeOff: 'Keep energy and face normal arrival pressure',
    },
  ];
  if (residentHealth !== null && residentHealth >= policy.shelterMinHealth)
    choices.push({
      id: 'shelter',
      effect: 'Shelter',
      tradeOff: 'Move up to five resident energy to the visitor and defer the contest once',
    });
  return choices;
}
export function resolveSpecialVote(
  options: readonly SpecialOption[],
  votes: readonly BallotVote[],
  fallback: SpecialChoice,
): { choice: SpecialChoice; counts: readonly number[] } {
  const tally = tallyVotes(votes, options.length);
  const choice =
    tally.winnerIndex === null ? fallback : (options[tally.winnerIndex]?.id ?? fallback);
  if (!options.some((option) => option.id === choice))
    throw new Error('Special ballot fallback is not offered');
  return { choice, counts: tally.counts };
}
export function welcomeArrival(
  health: number,
  choice: WelcomeChoice,
  existingReduction: number,
  rules: Ruleset,
  policy: RaidPolicy = candidateRaidPolicy,
): { health: number; spent: number; shockReduction: number; shelterPending: boolean } {
  assertLivingHealth(health, rules);
  welcomeChoiceSchema.parse(choice);
  const spent = choice === 'acclimate' ? Math.min(policy.acclimateCost, health - 1) : 0;
  return {
    health: health - spent,
    spent,
    shockReduction: existingReduction + (spent > 0 ? policy.acclimateShockReduction : 0),
    shelterPending: choice === 'shelter',
  };
}
/** Comparable fitness decides only after survival and confidence; shelter is consumed by one valid comparison. */
export function resolveVisitorContest(
  input: {
    confidence: 'confident' | 'limited' | 'interrupted';
    residentHealth: number | null;
    visitorHealth: number;
    residentFitness: number | null;
    visitorFitness: number;
    shelterPending: boolean;
  },
  policy: RaidPolicy = candidateRaidPolicy,
): {
  outcome: 'held' | 'empty' | 'visitor' | 'resident' | 'sheltered';
  residentHealth: number | null;
  visitorHealth: number;
  moved: number;
  shelterPending: boolean;
} {
  if (input.confidence !== 'confident')
    return {
      outcome: 'held',
      residentHealth: input.residentHealth,
      visitorHealth: input.visitorHealth,
      moved: 0,
      shelterPending: input.shelterPending,
    };
  if (input.visitorHealth === 0)
    return {
      outcome: input.residentHealth === null || input.residentHealth === 0 ? 'empty' : 'resident',
      residentHealth: input.residentHealth,
      visitorHealth: 0,
      moved: 0,
      shelterPending: false,
    };
  if (input.residentHealth === null || input.residentHealth === 0)
    return {
      outcome: 'visitor',
      residentHealth: input.residentHealth,
      visitorHealth: input.visitorHealth,
      moved: 0,
      shelterPending: false,
    };
  if (input.shelterPending) {
    const moved = Math.min(
      policy.shelterTransfer,
      input.residentHealth - 1,
      100 - input.visitorHealth,
    );
    return {
      outcome: 'sheltered',
      residentHealth: input.residentHealth - moved,
      visitorHealth: input.visitorHealth + moved,
      moved,
      shelterPending: false,
    };
  }
  return {
    outcome:
      input.visitorFitness > (input.residentFitness ?? input.visitorFitness)
        ? 'visitor'
        : 'resident',
    residentHealth: input.residentHealth,
    visitorHealth: input.visitorHealth,
    moved: 0,
    shelterPending: false,
  };
}
