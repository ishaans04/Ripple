import { canonicalJson, sha256Hex } from './canonical.ts';
import type { MutationCandidate } from './candidates.ts';
import { EngineError } from './errors.ts';
import { applyMove, GENES, moveId, type Genome } from './genome.ts';
import type { Ruleset } from './ruleset.ts';
import { scoreRound, type ScoreBreakdown, type ScoreInput } from './scoring.ts';

export interface RejectedChoiceReplay {
  readonly kind: 'rejected-choice';
  readonly candidateId: string;
  readonly score: ScoreBreakdown;
  readonly fitnessDifference: number;
  /** Difference in final energy, including health/delta clamps. */
  readonly energyDifference: number;
}
export interface AlternativeReplay {
  readonly kind: 'fixed-input-comparison';
  readonly exogenousHash: string;
  readonly actual: ScoreBreakdown;
  readonly rejected: readonly RejectedChoiceReplay[];
}
const sameGenome = (a: Genome, b: Genome) => GENES.every((gene) => a[gene] === b[gene]);

export function assertRecordedMutationCards(
  genomeBefore: Genome,
  candidates: readonly MutationCandidate[],
  rules: Ruleset,
): void {
  if (
    candidates.length !== rules.ballot.mutationCandidates ||
    new Set(candidates.map((c) => c.id)).size !== candidates.length
  )
    throw new EngineError(
      'INVALID_ARGUMENT',
      'a comparison requires the distinct recorded mutation cards',
    );
  for (const candidate of candidates) {
    const rebased = applyMove(genomeBefore, candidate.move, rules.genome);
    if (
      candidate.id !== moveId(candidate.move) ||
      rebased === null ||
      !sameGenome(rebased, candidate.genome)
    )
      throw new EngineError(
        'INVALID_ARGUMENT',
        'a recorded candidate does not match its pre-mutation genome',
      );
  }
}

/** Substitute recorded rejected choices only; no downstream branch, randomness, clock or I/O. */
export function replayRejectedChoices(
  input: {
    readonly genomeBefore: Genome;
    readonly candidates: readonly MutationCandidate[];
    readonly selectedId: string | null;
    readonly actual: ScoreInput;
  },
  rules: Ruleset,
): AlternativeReplay {
  assertRecordedMutationCards(input.genomeBefore, input.candidates, rules);
  const selected =
    input.selectedId === null ? undefined : input.candidates.find((c) => c.id === input.selectedId);
  if (
    (input.selectedId !== null && selected === undefined) ||
    !sameGenome(input.actual.genome, selected?.genome ?? input.genomeBefore)
  )
    throw new EngineError(
      'INVALID_ARGUMENT',
      'the actual result does not match the recorded choice',
    );
  const fixed = {
    healthBefore: input.actual.healthBefore,
    profile: { burst: input.actual.profile.burst, steadiness: input.actual.profile.steadiness },
    shocks: input.actual.shocks.map((s) => ({ ...s })),
    trace: input.actual.trace,
  };
  const actual = scoreRound({ ...fixed, genome: { ...input.actual.genome } }, rules);
  return {
    kind: 'fixed-input-comparison',
    exogenousHash: sha256Hex(canonicalJson(fixed)),
    actual,
    rejected: input.candidates
      .filter((c) => c.id !== input.selectedId)
      .map((c) => {
        const score = scoreRound({ ...fixed, genome: { ...c.genome } }, rules);
        return {
          kind: 'rejected-choice',
          candidateId: c.id,
          score,
          fitnessDifference: score.fitness - actual.fitness,
          energyDifference: score.healthAfter - actual.healthAfter,
        };
      }),
  };
}
