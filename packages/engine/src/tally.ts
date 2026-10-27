import type { MutationCandidate } from './candidates.ts';
import { EngineError } from './errors.ts';

/** An accepted chat vote, in intake order. */
export interface BallotVote {
  /** Scoped pseudonymous account key; never a display name. */
  readonly actorKey: string;
  /** The 1-based option number as typed in chat, for example 2 for `!ripple 2`. */
  readonly choice: number;
}

export interface TallyResult {
  /** Accepted votes per option, in the ballot's seeded order. */
  readonly counts: readonly number[];
  readonly totalVotes: number;
  /** 0-based winning option, or null when no valid vote was cast. */
  readonly winnerIndex: number | null;
  /** Later votes from accounts whose first valid vote already stands. */
  readonly ignoredDuplicates: number;
  /** Choices that name no option on this ballot; they do not use up the account's vote. */
  readonly ignoredInvalid: number;
}

/**
 * Count a ballot. Votes must be in acceptance order: each account's first
 * valid vote stands and cannot be changed. The most-supported option wins;
 * a tie goes to the option earliest in seeded order.
 */
export function tallyVotes(votes: readonly BallotVote[], optionCount: number): TallyResult {
  if (!Number.isSafeInteger(optionCount) || optionCount < 1) {
    throw new EngineError('INVALID_ARGUMENT', 'a ballot needs at least one option');
  }
  const counts = Array.from({ length: optionCount }, () => 0);
  const voted = new Set<string>();
  let ignoredDuplicates = 0;
  let ignoredInvalid = 0;
  for (const { actorKey, choice } of votes) {
    if (actorKey.length === 0) {
      throw new EngineError('INVALID_ARGUMENT', 'a vote needs an account key');
    }
    if (!Number.isSafeInteger(choice) || choice < 1 || choice > optionCount) {
      ignoredInvalid += 1;
    } else if (voted.has(actorKey)) {
      ignoredDuplicates += 1;
    } else {
      voted.add(actorKey);
      counts[choice - 1] = (counts[choice - 1] ?? 0) + 1;
    }
  }
  let winnerIndex: number | null = null;
  let winnerCount = 0;
  for (const [index, count] of counts.entries()) {
    // Strictly greater: an equal count later in seeded order never displaces the leader.
    if (count > winnerCount) {
      winnerIndex = index;
      winnerCount = count;
    }
  }
  return { counts, totalVotes: voted.size, winnerIndex, ignoredDuplicates, ignoredInvalid };
}

/** Hold is the no-vote outcome of a mutation ballot, separate from the offered cards. */
export type MutationBallotOutcome =
  | { readonly kind: 'mutation'; readonly index: number; readonly candidate: MutationCandidate }
  | { readonly kind: 'hold' };

export function resolveMutationBallot(
  candidates: readonly MutationCandidate[],
  votes: readonly BallotVote[],
): { tally: TallyResult; outcome: MutationBallotOutcome } {
  const tally = tallyVotes(votes, candidates.length);
  const candidate = tally.winnerIndex === null ? undefined : candidates[tally.winnerIndex];
  const outcome: MutationBallotOutcome =
    tally.winnerIndex === null || candidate === undefined
      ? { kind: 'hold' }
      : { kind: 'mutation', index: tally.winnerIndex, candidate };
  return { tally, outcome };
}
