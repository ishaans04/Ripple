import { assertRecordedMutationCards, replayRejectedChoices } from './alternative-replay.ts';
import type { MutationCandidate } from './candidates.ts';
import { EngineError } from './errors.ts';
import type { Genome } from './genome.ts';
import type { Ruleset } from './ruleset.ts';
import {
  assertLivingHealth,
  type HabitatProfile,
  type ScoreBreakdown,
  type TraceTemplate,
} from './scoring.ts';

export interface ChoiceEstimate {
  readonly candidateId: string;
  readonly effect: string;
  readonly tradeOff: string;
  readonly source: MutationCandidate['source'];
  readonly estimatedFitness: number;
  readonly estimatedEnergyChange: number;
  readonly relativeToHold: number;
}
export type ChoicePreview = {
  readonly label: 'Based on recent activity';
  readonly uncertainty: 'Estimate only; future chat, arrivals and category changes may differ.';
} & (
  | {
      readonly status: 'learning';
      readonly reason: 'No valid habitat profile yet';
      readonly cards: readonly [];
    }
  | {
      readonly status: 'estimate';
      readonly sourceRoundId: string;
      readonly exogenousHash: string;
      readonly hold: ScoreBreakdown;
      readonly cards: readonly ChoiceEstimate[];
    }
);

/** Only a previously known profile is accepted. Future shock/observation inputs have no parameter here. */
export function previewMutationChoices(
  input: {
    readonly genome: Genome;
    readonly healthBefore: number;
    readonly candidates: readonly MutationCandidate[];
    readonly recent: { readonly roundId: string; readonly profile: HabitatProfile } | null;
    readonly trace: TraceTemplate | null;
  },
  rules: Ruleset,
): ChoicePreview {
  assertRecordedMutationCards(input.genome, input.candidates, rules);
  assertLivingHealth(input.healthBefore, rules);
  const text = {
    label: 'Based on recent activity' as const,
    uncertainty: 'Estimate only; future chat, arrivals and category changes may differ.' as const,
  };
  if (input.recent === null)
    return { ...text, status: 'learning', reason: 'No valid habitat profile yet', cards: [] };
  if (input.recent.roundId.length === 0 || input.recent.roundId.length > 128)
    throw new EngineError('INVALID_ARGUMENT', 'a preview needs the recorded recent profile source');
  const comparison = replayRejectedChoices(
    {
      genomeBefore: input.genome,
      candidates: input.candidates,
      selectedId: null,
      actual: {
        genome: input.genome,
        healthBefore: input.healthBefore,
        profile: input.recent.profile,
        shocks: [],
        trace: input.trace,
      },
    },
    rules,
  );
  return {
    ...text,
    status: 'estimate',
    sourceRoundId: input.recent.roundId,
    exogenousHash: comparison.exogenousHash,
    hold: comparison.actual,
    cards: input.candidates.map((candidate, index) => {
      const result = comparison.rejected[index];
      if (result === undefined)
        throw new EngineError('INVALID_ARGUMENT', 'missing recorded candidate estimate');
      return {
        candidateId: candidate.id,
        effect: candidate.effect,
        tradeOff: candidate.tradeOff,
        source: candidate.source,
        estimatedFitness: result.score.fitness,
        estimatedEnergyChange: result.score.healthAfter - input.healthBefore,
        relativeToHold: result.energyDifference,
      };
    }),
  };
}
