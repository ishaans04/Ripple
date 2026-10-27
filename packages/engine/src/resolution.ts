import { compareToBaseline, type BaselineComparison, type FrozenBaseline } from './baseline.ts';
import { assertLegalGenome, type Genome } from './genome.ts';
import {
  buildActivityProfile,
  type ActivityObservation,
  type ActivityProfile,
  type ShockMarker,
} from './habitat.ts';
import type { Ruleset } from './ruleset.ts';
import {
  assertLivingHealth,
  scoreRound,
  type ScoreBreakdown,
  type TraceTemplate,
} from './scoring.ts';

/**
 * The input interval of an observation. Interrupted means the integration
 * could not vouch for the interval (outage, missing data); it is never
 * treated as a quiet habitat.
 */
export type ObservationWindow =
  | { readonly status: 'complete'; readonly observations: readonly ActivityObservation[] }
  | { readonly status: 'interrupted' };

export interface ResolutionInput {
  readonly genome: Genome;
  readonly healthBefore: number;
  readonly observation: ObservationWindow;
  readonly shocks: readonly ShockMarker[];
  readonly trace: TraceTemplate | null;
  /** The baseline frozen before this round opened. */
  readonly baseline: FrozenBaseline;
}

export type RoundResolution =
  /** No observation: health, traces, and contests do not progress. */
  | {
      readonly outcome: 'interrupted';
      readonly healthBefore: number;
      readonly healthAfter: number;
    }
  /** Too little data: the score is an estimate and health is held. Not a valid round. */
  | {
      readonly outcome: 'limited';
      readonly profile: ActivityProfile;
      readonly comparison: BaselineComparison;
      readonly estimate: ScoreBreakdown;
      readonly healthBefore: number;
      readonly healthAfter: number;
    }
  /** A valid observation round: the score is applied to health. */
  | {
      readonly outcome: 'applied';
      readonly profile: ActivityProfile;
      readonly comparison: BaselineComparison;
      readonly score: ScoreBreakdown;
      readonly healthBefore: number;
      readonly healthAfter: number;
      readonly extinct: boolean;
    };

/**
 * Close an observation round. A complete, confident observation is scored
 * and applied; a complete observation below confidence is estimated with
 * health held; an interrupted one changes nothing.
 */
export function resolveObservation(input: ResolutionInput, rules: Ruleset): RoundResolution {
  const { genome, healthBefore, observation, shocks, trace, baseline } = input;
  assertLegalGenome(genome, rules.genome);
  assertLivingHealth(healthBefore, rules);
  if (observation.status === 'interrupted') {
    return { outcome: 'interrupted', healthBefore, healthAfter: healthBefore };
  }
  const profile = buildActivityProfile(observation.observations, rules);
  const comparison = compareToBaseline(profile, baseline);
  const score = scoreRound({ genome, healthBefore, profile, shocks, trace }, rules);
  if (profile.confidence === 'limited') {
    return {
      outcome: 'limited',
      profile,
      comparison,
      estimate: score,
      healthBefore,
      healthAfter: healthBefore,
    };
  }
  return {
    outcome: 'applied',
    profile,
    comparison,
    score,
    healthBefore,
    healthAfter: score.healthAfter,
    extinct: score.extinct,
  };
}
