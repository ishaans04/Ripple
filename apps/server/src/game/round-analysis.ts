import { roundAnalysisSchema, type RoundAnalysis } from '@ripple/contracts';
import type pg from 'pg';
import type { WorldScope } from './sandbox.ts';

/** Uses the surrounding rounds alias r. Reads saved scores/inputs only, never today's engine rules. */
export const roundAnalysisProjectionSql = `case when r.resolution is not null or r.checkpoint ? 'traceDecisionCancelled' then jsonb_build_object(
 'schemaVersion',1,'roundId',r.id,'kind',r.kind,'rulesHash',r.rules_hash,
 'status',case when r.resolution is null then 'cancelled' else 'resolved' end,
 'mechanicsVersion',case when r.checkpoint ? 'activeTrace' then 1 else 0 end,
 'modelLabel','Fixed-input model comparisons; downstream viewer behavior is not simulated.',
 'scoringStage','before-shelter-settlement',
 'participants',case when r.resolution is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object(
   'organismId',p.organism_id,'role',p.role,
   'actual',jsonb_build_object('outcome',p.resolution->'outcome','healthBefore',p.resolution->'healthBefore','healthAfter',p.resolution->'healthAfter','score',coalesce(p.resolution->'score',p.resolution->'estimate'),'explanation',p.explanation),
   'ancestor',(select jsonb_build_object('ancestorId',a.ancestor_id,'rulesHash',a.rules_hash,'engineVersion',a.engine_version,'inputs',a.matched_inputs,'result',a.result)
     from ancestor_trials a where a.world_id=p.world_id and a.round_id=p.round_id and a.organism_id=p.organism_id)
 ) order by case when p.role='resident' then 0 else 1 end,p.organism_id) from round_participants p where p.world_id=r.world_id and p.round_id=r.id and p.resolution is not null),
 jsonb_build_array(jsonb_build_object('organismId',r.organism_id,'role','primary','actual',jsonb_build_object('outcome',r.resolution->'outcome','healthBefore',r.resolution->'healthBefore','healthAfter',r.resolution->'healthAfter','score',coalesce(r.resolution->'score',r.resolution->'estimate'),'explanation',r.explanation),'ancestor',null))) end,
 'alternative',(select jsonb_build_object('rulesHash',a.rules_hash,'engineVersion',a.engine_version,'confidence',a.confidence,'inputs',a.inputs,'result',a.result) from choice_replays a where a.world_id=r.world_id and a.round_id=r.id and a.organism_id=r.organism_id),
 'settlement',r.visitor_result->'contest','cancellation',r.checkpoint->'traceDecisionCancelled',
 'traceAttribution',case when r.resolution is null then null else (select jsonb_build_object('id',t.id,'emitterId',t.emitter_id,'lineageId',q.lineage_id,'originChannelId',l.origin_channel_id,'qualifyingRoundId',t.qualifying_round_id,'template',t.template)
   from habitat_traces t join trace_qualifications q on q.world_id=t.world_id and q.trace_id=t.id join lineages l on l.world_id=q.world_id and l.id=q.lineage_id
   where t.world_id=r.world_id and t.channel_id=r.channel_id and t.id=(r.checkpoint->'activeTrace'->>'id')::uuid) end,
 'dormantOffer',r.checkpoint->'dormantOffer'
) else null end`;

/** Missing comparisons in a modern scored round are an integrity failure, never a fabricated zero. */
export function parseSavedRoundAnalysis(value: unknown): RoundAnalysis {
  const analysis = roundAnalysisSchema.parse(value);
  if (analysis.status === 'resolved' && analysis.mechanicsVersion === 1) {
    if (
      analysis.participants.length === 0 ||
      analysis.participants.some((p) => p.actual.outcome === 'applied' && p.ancestor === null)
    )
      throw new Error('Missing saved matched ancestor comparison.');
    if (analysis.kind === 'MUTATION' && analysis.alternative === null)
      throw new Error('Missing saved rejected-choice comparison.');
  }
  return analysis;
}
export async function readRoundAnalysis(
  pool: pg.Pool,
  scope: WorldScope,
  roundId: string,
): Promise<{ found: boolean; analysis: RoundAnalysis | null }> {
  const row = (
    await pool.query<{ analysis: unknown }>(
      `select ${roundAnalysisProjectionSql} as analysis from rounds r join worlds w on w.id=r.world_id
    where r.world_id=$1 and r.channel_id=$2 and r.id=$3 and (w.expires_at is null or w.expires_at>clock_timestamp())`,
      [scope.worldId, scope.channelId, roundId],
    )
  ).rows[0];
  return row === undefined
    ? { found: false, analysis: null }
    : {
        found: true,
        analysis: row.analysis === null ? null : parseSavedRoundAnalysis(row.analysis),
      };
}
