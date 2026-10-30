import {
  canonicalJson,
  replayRejectedChoices,
  type RoundCheckpoint,
  type RoundResolution,
} from '@ripple/engine';
import type { GameContext } from './store.ts';

export async function recordChoiceReplay(
  context: GameContext,
  organismId: string,
  checkpoint: RoundCheckpoint,
  resolution: RoundResolution,
): Promise<void> {
  if (
    context.mechanics.version !== 1 ||
    resolution.outcome === 'interrupted' ||
    checkpoint.specialBallot !== undefined ||
    // A studio hatch had no cards to compare; its design came from the studio ballot.
    checkpoint.studioHatch !== undefined
  )
    return;
  const { round, client, channel, rules } = context;
  if (round === null) throw new Error('Missing rejected-choice round.');
  if (organismId !== round.organism_id) return;
  if (checkpoint.mutationSelection === undefined)
    throw new Error('Missing recorded ordinary ballot selection.');
  const score = resolution.outcome === 'applied' ? resolution.score : resolution.estimate;
  const inputs = {
    genomeBefore: checkpoint.genomeBefore,
    candidates: checkpoint.candidates,
    selectedId: checkpoint.mutationSelection.choiceId,
    actual: {
      genome: score.genome,
      healthBefore: score.healthBefore,
      profile: { burst: score.burst, steadiness: score.steadiness },
      shocks: checkpoint.shocks,
      trace: score.trace?.template ?? null,
    },
  };
  const result = replayRejectedChoices(inputs, rules);
  if (canonicalJson(result.actual) !== canonicalJson(score))
    throw new Error('Rejected-choice replay differs from the actual scored inputs.');
  await client.query(
    `insert into choice_replays(world_id,round_id,organism_id,rules_hash,engine_version,confidence,inputs,result)
     values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      channel.world_id,
      round.id,
      organismId,
      channel.rules_hash,
      rules.engineVersion,
      resolution.profile.confidence,
      {
        ...inputs,
        actualOutcome: resolution.outcome,
        actualHealthAfter: resolution.healthAfter,
        scoringStage: 'before-shelter-settlement',
      },
      result,
    ],
  );
}
