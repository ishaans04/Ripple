import { z } from 'zod';
import {
  lineageCatalogItemSchema,
  lineageCatalogSchema,
  lineageNodeSchema,
  lineagePageSchema,
  type LineageCatalog,
  type LineagePage,
} from '@ripple/contracts';
import type pg from 'pg';
import type { WorldScope } from './sandbox.ts';

/** The read capability grants family history only for lineages this channel originated or encountered. */
export const lineageVisibleSql = `(l.origin_channel_id=$2 or exists(
  select 1 from organisms witness join residencies residency on residency.world_id=witness.world_id and residency.organism_id=witness.id
  where witness.world_id=l.world_id and witness.lineage_id=l.id and residency.channel_id=$2
) or exists(
  select 1 from transfers transfer join organisms witness on witness.world_id=transfer.world_id and witness.id=transfer.child_id
  where transfer.world_id=l.world_id and witness.lineage_id=l.id and (transfer.source_channel_id=$2 or transfer.destination_channel_id=$2)
))`;

export async function readLineageCatalog(
  pool: pg.Pool,
  scope: WorldScope,
  limit: number,
  after?: { createdAt: string; id: string },
): Promise<LineageCatalog | null> {
  const row = (
    await pool.query<{ payload: unknown }>(
      `select jsonb_build_object('schemaVersion',1,'worldId',w.id,'channelId',$2::uuid,'mode',w.mode,
    'total',(select count(*) from lineages l where l.world_id=w.id and ${lineageVisibleSql}),
    'lineages',coalesce((select jsonb_agg(item order by created_at,id) from (
      select l.created_at,l.id,jsonb_build_object('lineageId',l.id,'createdAt',l.created_at,'origin',jsonb_build_object('channelId',origin.id,'label',origin.label),
        'founder',jsonb_build_object('id',founder.id,'name',founder.name,'status',founder.status),
        'counts',(select jsonb_build_object('total',count(*),'alive',count(*) filter(where status='ALIVE'),'harbor',count(*) filter(where status='HARBOR'),'fossil',count(*) filter(where status='FOSSIL'),'archived',count(*) filter(where status='ARCHIVED')) from organisms where world_id=l.world_id and lineage_id=l.id)
      ) as item from lineages l join channels origin on origin.world_id=l.world_id and origin.id=l.origin_channel_id
      join organisms founder on founder.world_id=l.world_id and founder.lineage_id=l.id and founder.parent_id is null
      where l.world_id=w.id and ${lineageVisibleSql} and ($3::timestamptz is null or (l.created_at,l.id)>($3::timestamptz,$4::uuid))
      order by l.created_at,l.id limit $5
    ) page),'[]'::jsonb)) as payload from worlds w where w.id=$1 and (w.expires_at is null or w.expires_at>clock_timestamp())`,
      [scope.worldId, scope.channelId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
    )
  ).rows[0];
  if (row === undefined) return null;
  const saved = lineageCatalogSchema
      .extend({
        lineages: z.array(lineageCatalogItemSchema).max(51),
        next: z.string().nullable().default(null),
      })
      .parse(row.payload),
    lineages = saved.lineages.slice(0, limit),
    last = lineages.at(-1);
  return lineageCatalogSchema.parse({
    ...saved,
    lineages,
    next:
      saved.lineages.length > limit && last !== undefined
        ? `${last.createdAt}|${last.lineageId}`
        : null,
  });
}

export async function readLineage(
  pool: pg.Pool,
  scope: WorldScope,
  lineageId: string,
  limit: number,
  after?: { generation: number; id: string },
): Promise<LineagePage | null> {
  const row = (
    await pool.query<{ payload: unknown }>(
      `select jsonb_build_object(
    'schemaVersion',1,'worldId',l.world_id,'lineageId',l.id,'mode',w.mode,'origin',jsonb_build_object('channelId',origin.id,'label',origin.label),
    'createdAt',l.created_at,'rulesHash',l.rules_hash,
    'counts',(select jsonb_build_object('total',count(*),'alive',count(*) filter(where status='ALIVE'),'harbor',count(*) filter(where status='HARBOR'),'fossil',count(*) filter(where status='FOSSIL'),'archived',count(*) filter(where status='ARCHIVED')) from organisms where world_id=l.world_id and lineage_id=l.id),
    'nodes',coalesce((select jsonb_agg(item order by generation,id) from (
      select o.generation,o.id,jsonb_build_object('id',o.id,'parentId',o.parent_id,'founderId',o.founder_id,'generation',o.generation,'name',o.name,
        'genome',jsonb_build_object('pulse',o.pulse,'calm',o.calm,'grit',o.grit,'drift',o.drift),'health',o.health,'status',o.status,'appearance',o.appearance,'createdAt',o.created_at,
        'lastHost',(select jsonb_build_object('channelId',c.id,'label',c.label,'role',r.role,'startedAt',r.started_at,'endedAt',r.ended_at)
          from residencies r join channels c on c.world_id=r.world_id and c.id=r.channel_id where r.world_id=o.world_id and r.organism_id=o.id
          order by (r.ended_at is null) desc,r.started_at desc,r.id desc limit 1),
        'birth',(select jsonb_build_object('transferId',t.id,'source',jsonb_build_object('channelId',source.id,'label',source.label),
          'destination',case when destination.id is null then null else jsonb_build_object('channelId',destination.id,'label',destination.label) end,
          'outcome',t.outcome,'historical',t.claimed_at is not null) from transfers t
          join channels source on source.world_id=t.world_id and source.id=t.source_channel_id
          left join channels destination on destination.world_id=t.world_id and destination.id=t.destination_channel_id
          where t.world_id=o.world_id and t.child_id=o.id order by t.created_at,t.id limit 1),
        'emittedTraces',(select count(*) from trace_qualifications q where q.world_id=o.world_id and q.emitter_id=o.id),
        'latestTrace',(select jsonb_build_object('id',t.id,'template',t.template,'status',t.status,'remainingRounds',t.remaining_rounds,'qualifyingRoundId',t.qualifying_round_id,'host',jsonb_build_object('channelId',c.id,'label',c.label))
          from habitat_traces t join trace_qualifications q on q.world_id=t.world_id and q.trace_id=t.id
          join channels c on c.world_id=t.world_id and c.id=t.channel_id join rounds qualification on qualification.world_id=t.world_id and qualification.id=t.qualifying_round_id
          where t.world_id=o.world_id and t.emitter_id=o.id order by qualification.opened_at desc,t.id desc limit 1)
      ) as item from organisms o where o.world_id=l.world_id and o.lineage_id=l.id and ($4::int is null or (o.generation,o.id)>($4::int,$5::uuid))
      order by o.generation,o.id limit $6
    ) page),'[]'::jsonb)
  ) as payload from lineages l join worlds w on w.id=l.world_id join channels origin on origin.world_id=l.world_id and origin.id=l.origin_channel_id
  where l.world_id=$1 and l.id=$3 and (w.expires_at is null or w.expires_at>clock_timestamp()) and ${lineageVisibleSql}`,
      [
        scope.worldId,
        scope.channelId,
        lineageId,
        after?.generation ?? null,
        after?.id ?? null,
        limit + 1,
      ],
    )
  ).rows[0];
  if (row === undefined) return null;
  const saved = lineagePageSchema
      .extend({
        nodes: z.array(lineageNodeSchema).max(51),
        next: z.string().nullable().default(null),
      })
      .parse(row.payload),
    nodes = saved.nodes.slice(0, limit),
    last = nodes.at(-1);
  return lineagePageSchema.parse({
    ...saved,
    nodes,
    next: saved.nodes.length > limit && last !== undefined ? `${last.generation}:${last.id}` : null,
  });
}
