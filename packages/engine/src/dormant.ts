import type { MutationCandidate } from './candidates.ts';
import { EngineError } from './errors.ts';
import { applyMove, type Genome, type MutationMove } from './genome.ts';
import type { Ruleset } from './ruleset.ts';
import { habitatFit, type HabitatProfile } from './scoring.ts';
import type { TallyResult } from './tally.ts';

/**
 * A minority-backed losing option preserved from an ordinary mutation
 * ballot. It is a direction, not a genome: it grants no genes, health, or
 * protection, and only aggregate support is kept, never who voted.
 */
export interface DormantCapture {
  /** Directional template, rebased onto whatever genome exists when it is reconsidered. */
  readonly move: MutationMove;
  /** Votes the option received. */
  readonly supporters: number;
  /** Valid votes cast on the ballot. */
  readonly totalVotes: number;
  /** Burst of the habitat profile known when it was captured. */
  readonly captureBurst: number | null;
}

export interface DormantCaptureInput {
  /** The ballot's cards in seeded order. */
  readonly candidates: readonly MutationCandidate[];
  readonly tally: TallyResult;
  readonly captureBurst: number | null;
}

/**
 * After an ordinary mutation ballot, preserve the highest-supported losing
 * option when enough votes were cast and it drew enough support: at least
 * minTotalVotes in total, and for the runner-up at least minRunnerUpVotes and
 * minRunnerUpPercent of the total. Ties use the ballot's seeded order. A
 * rejected dormant card has used its one offer, so if it is the runner-up
 * nothing is preserved.
 */
export function selectDormantCapture(
  input: DormantCaptureInput,
  rules: Ruleset,
): DormantCapture | null {
  const { candidates, tally, captureBurst } = input;
  if (tally.counts.length !== candidates.length) {
    throw new EngineError('INVALID_ARGUMENT', 'the tally does not belong to these candidates');
  }
  const { minTotalVotes, minRunnerUpVotes, minRunnerUpPercent } = rules.dormant;
  if (tally.winnerIndex === null || tally.totalVotes < minTotalVotes) {
    return null;
  }
  let runnerUp: number | null = null;
  let runnerUpVotes = 0;
  for (const [index, votes] of tally.counts.entries()) {
    if (index !== tally.winnerIndex && votes > runnerUpVotes) {
      runnerUp = index;
      runnerUpVotes = votes;
    }
  }
  const candidate = runnerUp === null ? undefined : candidates[runnerUp];
  if (
    candidate === undefined ||
    candidate.source === 'dormant' ||
    runnerUpVotes < minRunnerUpVotes ||
    100 * runnerUpVotes < minRunnerUpPercent * tally.totalVotes
  ) {
    return null;
  }
  return {
    move: candidate.move,
    supporters: runnerUpVotes,
    totalVotes: tally.totalVotes,
    captureBurst,
  };
}

export interface DormantOfferInput {
  readonly capture: DormantCapture;
  /** The current committed genome at the mutation round's opening. */
  readonly genome: Genome;
  /** The last known valid profile; never data from the round about to be observed. */
  readonly recentProfile: HabitatProfile | null;
}

export type DormantOfferEvaluation =
  | {
      readonly eligible: true;
      readonly move: MutationMove;
      readonly rebasedGenome: Genome;
      readonly profileChange: number;
      readonly currentFit: number;
      readonly rebasedFit: number;
    }
  | {
      readonly eligible: false;
      readonly reason:
        | 'no_valid_profile'
        | 'no_capture_profile'
        | 'profile_unchanged'
        | 'illegal_rebase'
        | 'no_fit_gain';
    };

/**
 * Decide, from already known data only, whether a dormant option joins the
 * next mutation ballot: the known profile must have moved at least
 * triggerBurstChange from the capture profile, the move must rebase legally
 * onto the current genome, and the rebased genome must estimate a strictly
 * higher habitat fit than the current one under that profile.
 */
export function evaluateDormantOffer(
  input: DormantOfferInput,
  rules: Ruleset,
): DormantOfferEvaluation {
  const { capture, genome, recentProfile } = input;
  if (recentProfile === null) {
    return { eligible: false, reason: 'no_valid_profile' };
  }
  if (capture.captureBurst === null) return { eligible: false, reason: 'no_capture_profile' };
  const profileChange = Math.abs(recentProfile.burst - capture.captureBurst);
  if (profileChange < rules.dormant.triggerBurstChange) {
    return { eligible: false, reason: 'profile_unchanged' };
  }
  const rebasedGenome = applyMove(genome, capture.move, rules.genome);
  if (rebasedGenome === null) {
    return { eligible: false, reason: 'illegal_rebase' };
  }
  const currentFit = habitatFit(genome, recentProfile, rules);
  const rebasedFit = habitatFit(rebasedGenome, recentProfile, rules);
  if (rebasedFit <= currentFit) {
    return { eligible: false, reason: 'no_fit_gain' };
  }
  return {
    eligible: true,
    move: capture.move,
    rebasedGenome,
    profileChange,
    currentFit,
    rebasedFit,
  };
}
