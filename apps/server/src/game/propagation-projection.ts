/** Correlated with c (channel). Keep inside the snapshot's single MVCC statement. */
const ancestry = (alias: string) => `
  'id',${alias}.id,'lineageId',${alias}.lineage_id,'parentId',${alias}.parent_id,
  'originChannelId',l.origin_channel_id,'originLabel',origin.label,'generation',${alias}.generation,
  'livingBranches',(select count(*) from organisms branch where branch.world_id=${alias}.world_id and branch.lineage_id=${alias}.lineage_id and branch.status in ('ALIVE','HARBOR'))`;
const transfer = `jsonb_build_object(
  'id',t.id,'version',t.version,'outcome',t.outcome,'childId',t.child_id,
  'lineageId',t.snapshot->'parent'->>'lineageId','sourceChannelId',t.source_channel_id,
  'sourceLabel',source.label,'destinationChannelId',t.destination_channel_id,
  'destinationLabel',destination.label,'expiresAt',t.expires_at,'createdAt',t.created_at)`;
const transferJoins = `join channels source on source.world_id=t.world_id and source.id=t.source_channel_id
  left join channels destination on destination.world_id=t.world_id and destination.id=t.destination_channel_id`;
export const propagationProjectionSql = `(
  select jsonb_build_object(
    'preparation',p.preparation,'preparationRequested',p.preparation_requested,
    'resident',(select jsonb_build_object(${ancestry('o')})
      from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id
      join lineages l on l.world_id=o.world_id and l.id=o.lineage_id
      join channels origin on origin.world_id=l.world_id and origin.id=l.origin_channel_id
      where r.world_id=c.world_id and r.channel_id=c.id and r.role='resident' and r.ended_at is null limit 1),
    'visitor',(select jsonb_build_object(${ancestry('o')},
      'name',o.name,'health',o.health,'welcomed',v.welcomed,'arrivalPending',v.arrival_pending,
      'shockReduction',v.shock_reduction,'shelterPending',v.shelter_pending)
      from visitor_state v join organisms o on o.world_id=v.world_id and o.id=v.organism_id
      join residencies r on r.world_id=v.world_id and r.organism_id=v.organism_id
      join lineages l on l.world_id=o.world_id and l.id=o.lineage_id
      join channels origin on origin.world_id=l.world_id and origin.id=l.origin_channel_id
      where v.world_id=c.world_id and v.channel_id=c.id and r.role='visitor' and r.ended_at is null limit 1),
    'admissions',coalesce((select jsonb_agg(item order by destination_sequence,created_at,id) from (
      select ${transfer} as item,t.destination_sequence,t.created_at,t.id from transfers t ${transferJoins}
      where t.world_id=c.world_id and t.destination_channel_id=c.id and t.child_id is not null
      and t.outcome in ('ACTIVE','QUEUED','PENDING_APPROVAL','OFFLINE_HOLD','GRANT_REVOKED','INPUT_UNAVAILABLE','RULES_INCOMPATIBLE','HARBOR')
      order by t.destination_sequence,t.created_at,t.id limit 4) pending),'[]'::jsonb),
    'outgoing',coalesce((select jsonb_agg(item order by created_at desc,id) from (
      select ${transfer} as item,t.created_at,t.id from transfers t ${transferJoins}
      where t.world_id=c.world_id and t.source_channel_id=c.id order by t.created_at desc,t.id limit 10) recent),'[]'::jsonb),
    'limits',rp.canonical::jsonb,
    'lastContest',(select jsonb_build_object('roundId',r.id,'visitorId',r.visitor_result->>'visitorId',
      'outcome',r.visitor_result->'contest'->>'outcome','moved',r.visitor_result->'contest'->'moved',
      'residentHealth',r.visitor_result->'contest'->'residentHealth','visitorHealth',r.visitor_result->'contest'->'visitorHealth')
      from rounds r where r.world_id=c.world_id and r.channel_id=c.id and r.visitor_result is not null order by r.number desc limit 1)
  ) from channel_play p join world_raid_policies wp on wp.world_id=p.world_id join raid_policies rp on rp.hash=wp.policy_hash
  where p.world_id=c.world_id and p.channel_id=c.id
)`;
