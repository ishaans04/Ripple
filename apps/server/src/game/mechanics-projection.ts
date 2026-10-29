/** Surrounding aliases c/channel and cp/play; all data shares the snapshot's MVCC statement. */
const traceItem = `jsonb_build_object('id',t.id,'version',t.version,'emitterId',t.emitter_id,'emitterName',o.name,
 'lineageId',q.lineage_id,'originChannelId',l.origin_channel_id,'originLabel',origin.label,'qualifyingRoundId',t.qualifying_round_id,
 'template',t.template,'status',t.status,'remainingRounds',t.remaining_rounds,'choice',t.decision->'choice',
 'reason',coalesce(t.decision->'terminal'->'reason',t.decision->'reason'))`;
const traceFrom = `from habitat_traces t join trace_qualifications q on q.world_id=t.world_id and q.trace_id=t.id
 join organisms o on o.world_id=t.world_id and o.id=t.emitter_id
 join lineages l on l.world_id=q.world_id and l.id=q.lineage_id
 join channels origin on origin.world_id=l.world_id and origin.id=l.origin_channel_id
 join rounds qualification on qualification.world_id=t.world_id and qualification.id=t.qualifying_round_id`;
const traceScope = `t.world_id=c.world_id and t.channel_id=c.id`;
export const mechanicsStateProjectionSql = `jsonb_build_object(
 'traceRules',(select canonical::jsonb->'traces' from rulesets where hash=c.rules_hash),
 'activeTrace',(select ${traceItem} ${traceFrom} where ${traceScope} and t.status='active' and cp.mechanics_version=1 and cp.traces_enabled limit 1),
 'pendingCount',(select count(*) from habitat_traces t join trace_qualifications q on q.world_id=t.world_id and q.trace_id=t.id where ${traceScope} and t.status='pending'),
 'pendingTraces',coalesce((select jsonb_agg(item order by number,id) from (select ${traceItem} as item,qualification.number,t.id ${traceFrom}
   where ${traceScope} and t.status='pending' order by qualification.number,t.id limit 8) pending),'[]'::jsonb),
 'recentTraces',coalesce((select jsonb_agg(item order by number desc,id) from (select ${traceItem} as item,qualification.number,t.id ${traceFrom}
   where ${traceScope} and t.status not in ('pending','active') order by qualification.number desc,t.id limit 8) recent),'[]'::jsonb),
 'dormant',coalesce((select jsonb_agg(item order by organism_id) from (select d.organism_id,jsonb_build_object(
   'id',d.id,'organismId',d.organism_id,'organismName',o.name,'lineageId',d.provenance->'lineageId',
   'originChannelId',origin.id,'originLabel',origin.label,'sourceRoundId',d.source_round_id,'template',d.template,
   'supporters',d.provenance->'supporters','totalVotes',d.provenance->'totalVotes','remainingRounds',d.remaining_rounds,
   'offered',d.offered,'inherited',d.provenance ? 'inheritedFrom') as item
   from dormant_mutations d join organisms o on o.world_id=d.world_id and o.id=d.organism_id
   join residencies residency on residency.world_id=d.world_id and residency.organism_id=d.organism_id and residency.ended_at is null
   join channels origin on origin.world_id=d.world_id and origin.id=(d.provenance->>'originChannelId')::uuid
   where d.world_id=c.world_id and residency.channel_id=c.id and residency.role in ('resident','visitor','harbor')
   and d.status='active' and d.remaining_rounds>0 order by d.organism_id limit 5) dormant),'[]'::jsonb)
)`;
