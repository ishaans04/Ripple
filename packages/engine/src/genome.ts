import { EngineError } from './errors.ts';

/**
 * The four genes in their fixed canonical order. Pulse and Calm set
 * environmental fit, Grit reduces shock, Drift preserves health in migration.
 * The order is used for sorting, tie-breaking, and display.
 */
export const GENES = ['pulse', 'calm', 'grit', 'drift'] as const;
export type Gene = (typeof GENES)[number];

export type Genome = Readonly<Record<Gene, number>>;

export interface GenomeRules {
  /** Inclusive bounds for every gene. */
  readonly min: number;
  readonly max: number;
  /** Exact gene total every legal genome conserves. */
  readonly budget: number;
  /** Points a standard mutation moves from one gene to another. */
  readonly mutationStep: number;
}

/** A directional transfer of `amount` points from one gene to another. */
export interface MutationMove {
  readonly from: Gene;
  readonly to: Gene;
  readonly amount: number;
}

function isGene(value: unknown): value is Gene {
  return (GENES as readonly unknown[]).includes(value);
}

export function isLegalGenome(genome: Genome, rules: GenomeRules): boolean {
  const keys = Object.keys(genome);
  if (keys.length !== GENES.length || !keys.every(isGene)) {
    return false;
  }
  let total = 0;
  for (const gene of GENES) {
    const value = genome[gene];
    if (!Number.isSafeInteger(value) || value < rules.min || value > rules.max) {
      return false;
    }
    total += value;
  }
  return total === rules.budget;
}

export function assertLegalGenome(genome: Genome, rules: GenomeRules): void {
  if (!isLegalGenome(genome, rules)) {
    throw new EngineError(
      'ILLEGAL_GENOME',
      `genome must have four integer genes in [${rules.min}, ${rules.max}] summing to ${rules.budget}`,
    );
  }
}

/** Stable identifier of a move, for example "calm+2/drift-2". */
export function moveId(move: MutationMove): string {
  return `${move.to}+${move.amount}/${move.from}-${move.amount}`;
}

/**
 * The genome after a move, or null when the result would leave the gene
 * bounds. A move that is not a transfer of the configured step between two
 * distinct genes is malformed and rejected.
 */
export function applyMove(genome: Genome, move: MutationMove, rules: GenomeRules): Genome | null {
  assertLegalGenome(genome, rules);
  if (!isGene(move.from) || !isGene(move.to) || move.from === move.to) {
    throw new EngineError('ILLEGAL_MOVE', 'a move transfers points between two distinct genes');
  }
  if (move.amount !== rules.mutationStep) {
    throw new EngineError('ILLEGAL_MOVE', `a move transfers exactly ${rules.mutationStep} points`);
  }
  const next: Genome = {
    ...genome,
    [move.from]: genome[move.from] - move.amount,
    [move.to]: genome[move.to] + move.amount,
  };
  return isLegalGenome(next, rules) ? next : null;
}

/**
 * Every legal standard mutation of a genome, sorted by gained gene and then
 * lost gene in canonical gene order. This sorted list is the input to the
 * seeded candidate shuffle, so its order is part of the rules.
 */
export function legalMoves(genome: Genome, rules: GenomeRules): MutationMove[] {
  const moves: MutationMove[] = [];
  for (const to of GENES) {
    for (const from of GENES) {
      if (from === to) {
        continue;
      }
      const move: MutationMove = { from, to, amount: rules.mutationStep };
      if (applyMove(genome, move, rules) !== null) {
        moves.push(move);
      }
    }
  }
  return moves;
}
