import { EngineError } from './errors.ts';
import {
  applyMove,
  legalMoves,
  moveId,
  type Gene,
  type Genome,
  type MutationMove,
} from './genome.ts';
import { generatorFromSeedMaterial, shuffle } from './random.ts';
import { rulesetHash, type Ruleset } from './ruleset.ts';

/** One mutation card on a ballot. */
export interface MutationCandidate {
  /** Stable identifier derived from the move, for example "grit+2/pulse-2". */
  readonly id: string;
  readonly move: MutationMove;
  /** The genome if this card is selected. */
  readonly genome: Genome;
  /** Viewer-facing name of what the creature gains. */
  readonly effect: string;
  /** Viewer-facing name of what it gives up. */
  readonly tradeOff: string;
  /** Seeded generation, or a preserved dormant option from an earlier ballot. */
  readonly source: 'generated' | 'dormant';
}

export interface MutationBallotInput {
  /** Recorded seed of the world or channel. */
  readonly seed: string;
  readonly roundId: string;
  /** The current committed genome. */
  readonly genome: Genome;
  /** A dormant move already found eligible for this round, rebased onto the genome. */
  readonly dormantMove?: MutationMove;
}

const gainedEffect: Readonly<Record<Gene, string>> = {
  pulse: 'Specialize for bursts',
  calm: 'Settle into steady chat',
  grit: 'Reinforce shell',
  drift: 'Pack a travel reserve',
};

const lostTradeOff: Readonly<Record<Gene, string>> = {
  pulse: 'Less burst affinity',
  calm: 'Less steadiness',
  grit: 'Thinner shell',
  drift: 'Smaller travel reserve',
};

/** Card wording for a move: the concrete action, then its cost. */
export function describeMove(move: MutationMove): { effect: string; tradeOff: string } {
  return { effect: gainedEffect[move.to], tradeOff: lostTradeOff[move.from] };
}

function toCandidate(
  genome: Genome,
  move: MutationMove,
  source: MutationCandidate['source'],
  rules: Ruleset,
): MutationCandidate {
  const next = applyMove(genome, move, rules.genome);
  if (next === null) {
    throw new EngineError('ILLEGAL_MOVE', `${moveId(move)} is not legal for the current genome`);
  }
  return { id: moveId(move), move, genome: next, ...describeMove(move), source };
}

/**
 * The mutation cards for one ballot, in the ballot's seeded order (which also
 * breaks vote ties). The sorted legal-move list is shuffled with Fisher-Yates
 * by a generator seeded from the recorded seed, round ID, rules hash, and
 * current genome, and the first cards are taken. An eligible dormant move
 * occupies the last slot and is excluded from the shuffled pool.
 */
export function generateMutationCandidates(
  input: MutationBallotInput,
  rules: Ruleset,
): MutationCandidate[] {
  const { seed, roundId, genome, dormantMove } = input;
  if (seed.length === 0 || roundId.length === 0) {
    throw new EngineError('INVALID_ARGUMENT', 'a ballot needs a recorded seed and a round ID');
  }
  const dormant =
    dormantMove === undefined ? null : toCandidate(genome, dormantMove, 'dormant', rules);
  const generatedCount = rules.ballot.mutationCandidates - (dormant === null ? 0 : 1);
  const pool = legalMoves(genome, rules.genome).filter((move) => moveId(move) !== dormant?.id);
  if (pool.length < generatedCount) {
    throw new EngineError(
      'INSUFFICIENT_CANDIDATES',
      `the genome offers ${pool.length} legal moves; the ballot needs ${generatedCount}`,
    );
  }
  const generator = generatorFromSeedMaterial({
    purpose: 'mutation-candidates',
    seed,
    roundId,
    rulesHash: rulesetHash(rules),
    genome,
  });
  const generated = shuffle(pool, generator)
    .slice(0, generatedCount)
    .map((move) => toCandidate(genome, move, 'generated', rules));
  return dormant === null ? generated : [...generated, dormant];
}
