import type { RoundTimings } from '@ripple/contracts';
import { freezeBaseline, type BaselineRound, type FrozenBaseline } from './baseline.ts';
import { generateMutationCandidates, type MutationCandidate } from './candidates.ts';
import { explainResolution, type OutcomeExplanation } from './explanation.ts';
import type { Genome } from './genome.ts';
import type { ActivityObservation, ShockMarker } from './habitat.ts';
import { resolveObservation, type RoundResolution } from './resolution.ts';
import { openRoundClock, type RoundClock } from './round-clock.ts';
import { assertCompatibleRuleset, type Ruleset } from './ruleset.ts';
import {
  completeSlotObservation,
  consumeMutationSlot,
  type MutationSlots,
} from './studio-slots.ts';
import { resolveMutationBallot, type BallotVote, type TallyResult } from './tally.ts';
import type { SpecialOption } from './arrival.ts';
import type { ChoicePreview } from './choice-preview.ts';

export interface RoundCheckpoint {
  readonly schemaVersion: 1;
  readonly clock: RoundClock;
  readonly candidates: readonly MutationCandidate[];
  readonly baseline: FrozenBaseline;
  readonly genomeBefore: Genome;
  readonly counts: readonly number[];
  readonly shocks: readonly ShockMarker[];
  /** Recorded at ordinary ballot close; null is the explicit no-vote Hold. */
  readonly mutationSelection?: { readonly choiceId: string | null };
  readonly choicePreview?: ChoicePreview;
  readonly specialBallot?: {
    readonly kind: 'WELCOME' | 'PREPARATION';
    readonly options: readonly SpecialOption[];
    readonly visitorId?: string;
  };
}
export function openMutationRound(
  input: {
    readonly seed: string;
    readonly roundId: string;
    readonly genome: Genome;
    readonly history: readonly BaselineRound[];
    readonly atMs: number;
    readonly timings: RoundTimings;
  },
  rules: Ruleset,
): RoundCheckpoint {
  assertCompatibleRuleset(rules);
  const candidates = generateMutationCandidates(input, rules);
  return {
    schemaVersion: 1,
    clock: openRoundClock(input.atMs, input.timings),
    candidates,
    baseline: freezeBaseline(input.history, rules),
    genomeBefore: { ...input.genome },
    counts: candidates.map(() => 0),
    shocks: [],
  };
}
export function closeMutationRound(
  checkpoint: RoundCheckpoint,
  votes: readonly BallotVote[],
  slots: MutationSlots,
  operationId: string,
): {
  readonly genome: Genome;
  readonly slots: MutationSlots;
  readonly tally: TallyResult;
  readonly choiceId: string | null;
} {
  const { tally, outcome } = resolveMutationBallot(checkpoint.candidates, votes);
  const choiceId = outcome.kind === 'mutation' ? outcome.candidate.id : null;
  return {
    genome: outcome.kind === 'mutation' ? outcome.candidate.genome : checkpoint.genomeBefore,
    slots: consumeMutationSlot(
      slots,
      operationId,
      slots.commitments.find((item) => item.operationId === operationId)?.slot ?? slots.next,
      choiceId ?? 'hold',
    ),
    tally,
    choiceId,
  };
}
export function finishRoundObservation(
  input: {
    readonly checkpoint: RoundCheckpoint;
    readonly genome: Genome;
    readonly health: number;
    readonly slots: MutationSlots;
    readonly observations: readonly ActivityObservation[];
  },
  rules: Ruleset,
): {
  readonly resolution: RoundResolution;
  readonly explanation: OutcomeExplanation;
  readonly slots: MutationSlots;
} {
  const resolution = resolveObservation(
    {
      genome: input.genome,
      healthBefore: input.health,
      baseline: input.checkpoint.baseline,
      observation: { status: 'complete', observations: input.observations },
      shocks: input.checkpoint.shocks,
      trace: null,
    },
    rules,
  );
  return {
    resolution,
    explanation: explainResolution(resolution, rules),
    // Complete limited observations still satisfy the mutation clock; only health/qualification are held.
    slots: completeSlotObservation(input.slots, input.slots.lastMutation, true),
  };
}
