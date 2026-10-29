import {
  canonicalJson,
  runAncestorTrial,
  type Genome,
  type RoundCheckpoint,
  type RoundResolution,
  type ScoreInput,
} from '@ripple/engine';
import type { GameContext } from './store.ts';

/** Analysis uses the scored boundary before finite Shelter transfers settle real energy. */
export async function recordAncestorTrial(
  context: GameContext,
  organismId: string,
  checkpoint: RoundCheckpoint,
  resolution: RoundResolution,
): Promise<void> {
  if (context.mechanics.version !== 1 || resolution.outcome !== 'applied') return;
  const { client, channel, round, rules } = context;
  if (round === null) throw new Error('Missing ancestor trial round.');
  const origin = (
    await client.query<{
      founder_id: string;
      founding_genome: Genome;
      arrival: unknown;
    }>(
      `select o.founder_id,f.founding_genome,
       (select jsonb_build_object('pending',v.arrival_pending,'shockReduction',v.shock_reduction,'shelterPending',v.shelter_pending)
        from visitor_state v where v.world_id=o.world_id and v.organism_id=o.id) as arrival
       from organisms o join organisms f on f.world_id=o.world_id and f.id=o.founder_id
       where o.world_id=$1 and o.id=$2`,
      [channel.world_id, organismId],
    )
  ).rows[0];
  if (origin === undefined) throw new Error('Missing immutable founding genome.');
  const scoreInput: ScoreInput = {
    genome: resolution.score.genome,
    healthBefore: resolution.healthBefore,
    profile: { burst: resolution.profile.burst, steadiness: resolution.profile.steadiness },
    shocks: checkpoint.shocks,
    trace: resolution.score.trace?.template ?? null,
  };
  const result = runAncestorTrial(scoreInput, origin.founding_genome, rules);
  if (canonicalJson(result.current) !== canonicalJson(resolution.score))
    throw new Error('Ancestor trial does not match the captured actual score.');
  await client.query(
    `insert into ancestor_trials(world_id,round_id,organism_id,ancestor_id,matched_inputs,result,rules_hash,engine_version)
     values($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      channel.world_id,
      round.id,
      organismId,
      origin.founder_id,
      {
        schemaVersion: 1,
        scoreInput,
        arrival: origin.arrival,
        scoringStage: 'before-shelter-settlement',
      },
      result,
      channel.rules_hash,
      rules.engineVersion,
    ],
  );
}
