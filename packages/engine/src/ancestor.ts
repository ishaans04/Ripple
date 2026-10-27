import { GENES, assertLegalGenome, type Genome } from './genome.ts';
import type { Ruleset } from './ruleset.ts';
import { scoreRound, type ScoreBreakdown, type ScoreInput } from './scoring.ts';

/**
 * A fixed-input comparison between a living strain and its lineage's
 * founding genome. The shadow is a record only: it has no residency, votes,
 * health persistence, descendants, trace eligibility, or rewards.
 */
export interface AncestorTrial {
  readonly current: ScoreBreakdown;
  /** The founding genome scored under the same inputs; its health is hypothetical. */
  readonly ancestor: ScoreBreakdown;
  readonly identicalGenome: boolean;
  /** current.fitness - ancestor.fitness. */
  readonly fitnessDifference: number;
  /** current.delta - ancestor.delta. */
  readonly deltaDifference: number;
}

/**
 * Score the founding genome beside the current one with the same start
 * health, profile, shocks, trace, and rules. Gene-dependent effects such as
 * Grit protection are recomputed for each genome, never copied across.
 */
export function runAncestorTrial(
  round: ScoreInput,
  ancestorGenome: Genome,
  rules: Ruleset,
): AncestorTrial {
  assertLegalGenome(ancestorGenome, rules.genome);
  const current = scoreRound(round, rules);
  const ancestor = scoreRound({ ...round, genome: ancestorGenome }, rules);
  return {
    current,
    ancestor,
    identicalGenome: GENES.every((gene) => round.genome[gene] === ancestorGenome[gene]),
    fitnessDifference: current.fitness - ancestor.fitness,
    deltaDifference: current.delta - ancestor.delta,
  };
}
