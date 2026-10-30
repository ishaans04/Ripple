import { familyDigestSchema, FAMILY_DIGEST_LIMIT, type FamilyDigest } from '@ripple/contracts';
import type { GameContext } from './store.ts';
import { lineageVisibleSql } from './lineage-read.ts';

/**
 * Captures the family digest when a channel's stream returns: up to three structural updates
 * from elsewhere in its lineages since its acknowledged cursor, most significant first. Every
 * visible lineage's cursor then advances to its latest update, so the next return shows only
 * newer news. Lineages first met later start from that encounter, not from older history.
 */
export async function captureFamilyDigest(context: GameContext, atMs: number): Promise<void> {
  const { client, channel } = context,
    scope = [channel.world_id, channel.id];
  const pending = (
    await client.query<{ items: unknown; total: number }>(
      `with visible as (
      select l.id,l.origin_channel_id,(select max(u.sequence) from lineage_updates u where u.world_id=l.world_id and u.lineage_id=l.id) as latest
      from lineages l where l.world_id=$1 and ${lineageVisibleSql}
    ), since as (
      select v.id as lineage_id,v.latest,coalesce(c.version,case when v.origin_channel_id=$2 then 0 else coalesce(
        (select min(u.sequence) from lineage_updates u where u.world_id=$1 and u.lineage_id=v.id and u.channel_id=$2),
        v.latest,0) end) as after
      from visible v left join descendant_cursors c on c.world_id=$1 and c.channel_id=$2 and c.lineage_id=v.id
    ), news as (
      select u.*,case u.kind when 'fossilized' then 0 when 'archived' then 1 when 'admitted' then 2 when 'born' then 3 else 4 end as priority
      from since s join lineage_updates u on u.world_id=$1 and u.lineage_id=s.lineage_id and u.sequence>s.after
      where u.channel_id is distinct from $2
    ), chosen as (
      select n.*,count(*) over () as total from news n order by n.priority,n.sequence desc,n.lineage_id limit ${FAMILY_DIGEST_LIMIT}
    )
    select coalesce(jsonb_agg(jsonb_build_object('kind',n.kind,'lineageId',n.lineage_id,'sequence',n.sequence,
        'organismId',o.id,'organismName',o.name,'generation',o.generation,
        'host',case when h.id is null then null else jsonb_build_object('channelId',h.id,'label',h.label) end,
        'traceTemplate',t.template) order by n.priority,n.sequence desc,n.lineage_id),'[]'::jsonb) as items,
      coalesce(max(n.total),0)::int as total
    from chosen n join organisms o on o.world_id=$1 and o.id=n.organism_id
    left join channels h on h.world_id=$1 and h.id=n.channel_id
    left join habitat_traces t on t.world_id=$1 and t.id=n.trace_id`,
      scope,
    )
  ).rows[0];
  await client.query(
    `insert into descendant_cursors(world_id,channel_id,lineage_id,version)
    select $1,$2,l.id,coalesce((select max(u.sequence) from lineage_updates u where u.world_id=l.world_id and u.lineage_id=l.id),0)
    from lineages l where l.world_id=$1 and ${lineageVisibleSql}
    on conflict (world_id,channel_id,lineage_id) do update set version=greatest(descendant_cursors.version,excluded.version)`,
    scope,
  );
  const digest: FamilyDigest = familyDigestSchema.parse({
    items: pending?.items ?? [],
    remaining: Math.max(0, (pending?.total ?? 0) - FAMILY_DIGEST_LIMIT),
  });
  if (digest.items.length === 0) {
    await clearFamilyDigest(context);
    return;
  }
  await client.query(
    `insert into family_digests(world_id,channel_id,captured_at,items,remaining) values($1,$2,$3,$4,$5)
    on conflict (world_id,channel_id) do update set captured_at=excluded.captured_at,items=excluded.items,remaining=excluded.remaining`,
    [...scope, new Date(atMs), JSON.stringify(digest.items), digest.remaining],
  );
}

/** A digest belongs to one stream session; it is removed when the stream goes offline. */
export async function clearFamilyDigest(context: GameContext): Promise<void> {
  await context.client.query('delete from family_digests where world_id=$1 and channel_id=$2', [
    context.channel.world_id,
    context.channel.id,
  ]);
}
