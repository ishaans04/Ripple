import { blueprintSchema, type AppearanceBlueprint } from '@ripple/contracts';
import { applyMove, moveId, type Genome } from './genome.ts';
import { studioMutationMove } from './studio-challenge.ts';
import { blueprintHash } from './studio-blueprint.ts';
import type { Ruleset } from './ruleset.ts';
import type { StudioFinalist } from './studio-selection.ts';
import type { TallyResult } from './tally.ts';

export function studioDormantFinalist(
  finalists: readonly StudioFinalist[],
  tally: TallyResult,
  winningBlueprint: AppearanceBlueprint | null,
  rules: Ruleset,
): StudioFinalist | null {
  if (tally.totalVotes < rules.dormant.minTotalVotes) return null;
  const winnerMove =
    winningBlueprint === null ? null : studioMutationMove(winningBlueprint.mutationTemplateId);
  const ranked = finalists
    .map((finalist, index) => ({ finalist, index, votes: tally.counts[index] ?? 0 }))
    .filter(
      (item) => winningBlueprint === null || item.finalist.hash !== blueprintHash(winningBlueprint),
    )
    .sort((a, b) => b.votes - a.votes || a.index - b.index);
  const loser = ranked[0];
  if (loser === undefined) return null;
  const move = studioMutationMove(loser.finalist.blueprint.mutationTemplateId);
  if (
    move === null ||
    (winnerMove !== null && moveId(move) === moveId(winnerMove)) ||
    loser.votes < rules.dormant.minRunnerUpVotes ||
    100 * loser.votes < rules.dormant.minRunnerUpPercent * tally.totalVotes
  )
    return null;
  return loser.finalist;
}

export function evaluateDormantBlueprint(
  value: unknown,
  genome: Genome,
  remainingRounds: number,
  rules: Ruleset,
):
  | {
      readonly eligible: true;
      readonly blueprint: AppearanceBlueprint;
      readonly sourceHash: string;
      readonly genome: Genome;
    }
  | {
      readonly eligible: false;
      readonly reason: 'expired' | 'unsupported_design' | 'cosmetic_only' | 'illegal_rebase';
    } {
  if (!Number.isSafeInteger(remainingRounds) || remainingRounds <= 0)
    return { eligible: false, reason: 'expired' };
  const parsed = blueprintSchema.safeParse(value);
  if (!parsed.success) return { eligible: false, reason: 'unsupported_design' };
  const move = studioMutationMove(parsed.data.mutationTemplateId);
  if (move === null) return { eligible: false, reason: 'cosmetic_only' };
  const rebased = applyMove(genome, move, rules.genome);
  if (rebased === null) return { eligible: false, reason: 'illegal_rebase' };
  return {
    eligible: true,
    blueprint: parsed.data,
    sourceHash: blueprintHash(parsed.data),
    genome: rebased,
  };
}
