import {
  ancestryMarks,
  appearanceMappingVersionSchema,
  markHostSchema,
  type AppearanceMarks,
  type AppearanceMappingVersion,
  type MarkHost,
} from '@ripple/contracts';
import { z } from 'zod';

/**
 * Hosts the organism's ancestry chain was actually admitted to (resident or visitor, never
 * harbor), ordered from the founder down the chain. An organism only ever resides in the one
 * channel it was founded in or admitted to, so chain depth (not timestamps from separate channel
 * clocks) gives a stable first-admission order. Expects the organism alias `o`.
 */
export const organismHostsSql = `(with recursive chain(id,parent_id,depth) as (
    select o.id,o.parent_id,0
    union all
    select p.id,p.parent_id,ch.depth+1 from chain ch
      join organisms p on p.world_id=o.world_id and p.id=ch.parent_id where ch.depth<16
  )
  select coalesce(jsonb_agg(jsonb_build_object('channelId',h.channel_id,'label',h.label) order by h.depth desc,h.first_at,h.channel_id),'[]'::jsonb)
  from (select r.channel_id,c.label,max(ch.depth) as depth,min(r.started_at) as first_at from chain ch
    join residencies r on r.world_id=o.world_id and r.organism_id=ch.id and r.role in ('resident','visitor')
    join channels c on c.world_id=r.world_id and c.id=r.channel_id
    group by r.channel_id,c.label) h)`;

/** The lineage origin channel for the organism alias `o`. */
export const organismOriginSql = `(select jsonb_build_object('channelId',origin.id,'label',origin.label)
  from lineages ol join channels origin on origin.world_id=ol.world_id and origin.id=ol.origin_channel_id
  where ol.world_id=o.world_id and ol.id=o.lineage_id)`;

// One admitted host per generation at most: generations 0 through 16.
export const organismHostsSchema = z.array(markHostSchema).max(17);

export function organismAppearanceProvenance(
  saved: { appearanceMapping: unknown; origin: unknown; hosts: unknown },
  options: { includeHosts: false },
): { appearanceMapping: AppearanceMappingVersion; marks: AppearanceMarks };
export function organismAppearanceProvenance(
  saved: { appearanceMapping: unknown; origin: unknown; hosts: unknown },
  options: { includeHosts: true },
): { appearanceMapping: AppearanceMappingVersion; marks: AppearanceMarks; hosts: MarkHost[] };
export function organismAppearanceProvenance(
  saved: { appearanceMapping: unknown; origin: unknown; hosts: unknown },
  options: { includeHosts: boolean },
) {
  const hosts = organismHostsSchema.parse(saved.hosts),
    provenance = {
      appearanceMapping: appearanceMappingVersionSchema.parse(saved.appearanceMapping),
      marks: ancestryMarks(markHostSchema.parse(saved.origin), hosts),
    };
  return options.includeHosts ? { ...provenance, hosts } : provenance;
}
