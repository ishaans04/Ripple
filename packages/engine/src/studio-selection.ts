import type { StudioChallenge } from '@ripple/contracts';
import { acceptBlueprint, type AcceptedBlueprint } from './studio-blueprint.ts';
import { generatorFromSeedMaterial, shuffle } from './random.ts';
import type { Ruleset } from './ruleset.ts';
import { tallyVotes, type BallotVote, type TallyResult } from './tally.ts';

export interface StudioFinalist extends AcceptedBlueprint {
  readonly proposalId: string;
}
export interface StudioShortlist {
  readonly finalists: readonly StudioFinalist[];
  readonly rejected: readonly { readonly proposalId: string; readonly reason: string }[];
}
export function shortlistStudioProposals(
  proposals: readonly {
    readonly id: string;
    readonly artistKey: string;
    readonly blueprint: unknown;
  }[],
  challenge: StudioChallenge,
  seed: string,
  rules: Ruleset,
): StudioShortlist {
  const seenIds = new Set<string>();
  const seenArtists = new Set<string>();
  const valid: StudioFinalist[] = [];
  const rejected: { proposalId: string; reason: string }[] = [];
  const sorted = [...proposals].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const proposal of sorted) {
    if (
      !proposal.id ||
      !proposal.artistKey ||
      seenIds.has(proposal.id) ||
      seenArtists.has(proposal.artistKey)
    ) {
      rejected.push({ proposalId: proposal.id, reason: 'duplicate_or_unattributed' });
      continue;
    }
    seenIds.add(proposal.id);
    seenArtists.add(proposal.artistKey);
    try {
      valid.push({
        proposalId: proposal.id,
        ...acceptBlueprint(proposal.blueprint, challenge, rules),
      });
    } catch {
      rejected.push({ proposalId: proposal.id, reason: 'invalid_blueprint' });
    }
  }
  const ordered = shuffle(
    valid,
    generatorFromSeedMaterial({
      purpose: 'studio-shortlist',
      seed,
      session: challenge.studioSessionId,
      rulesHash: challenge.rulesHash,
    }),
  );
  const first = ordered[0];
  if (first === undefined) return { finalists: [], rejected };
  const rest = ordered.slice(1);
  const second =
    rest.find((item) => item.blueprint.mutationTemplateId !== first.blueprint.mutationTemplateId) ??
    rest[0];
  return { finalists: second === undefined ? [first] : [first, second], rejected };
}

export type StudioSelection =
  | { readonly kind: 'keep_current'; readonly reason: 'no_proposals' | 'no_votes' | 'selected' }
  | { readonly kind: 'design'; readonly finalist: StudioFinalist };

/** Keep current is last, the no-vote default, and wins ties against any finalist. */
export function resolveStudioSelection(
  finalists: readonly StudioFinalist[],
  votes: readonly BallotVote[],
): {
  readonly tally: TallyResult;
  readonly outcome: StudioSelection;
} {
  if (finalists.length > 2) throw new RangeError('A studio ballot has at most two finalists.');
  const tally = tallyVotes(votes, finalists.length + 1);
  if (finalists.length === 0)
    return { tally, outcome: { kind: 'keep_current', reason: 'no_proposals' } };
  if (tally.totalVotes === 0)
    return { tally, outcome: { kind: 'keep_current', reason: 'no_votes' } };
  const keepVotes = tally.counts[finalists.length] ?? 0;
  const maximum = Math.max(...tally.counts);
  const winner = tally.winnerIndex === null ? undefined : finalists[tally.winnerIndex];
  if (keepVotes === maximum || winner === undefined) {
    return { tally, outcome: { kind: 'keep_current', reason: 'selected' } };
  }
  return { tally, outcome: { kind: 'design', finalist: winner } };
}
