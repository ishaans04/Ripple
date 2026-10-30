import { z } from 'zod';
import {
  PASSPORT_ADAPTATION_PAGE,
  PASSPORT_RECORD_LIMIT,
  passportAdaptationSchema,
  passportSchema,
  studioGenomeSchema,
  type Passport,
  type PassportAdaptation,
} from '@ripple/contracts';
import type pg from 'pg';
import type { WorldScope } from './sandbox.ts';
import { lineageVisibleSql } from './lineage-read.ts';
import {
  organismAppearanceProvenance,
  organismHostsSql,
  organismOriginSql,
} from './appearance-projection.ts';

const genome = studioGenomeSchema;
const savedAdaptationSchema = z.object({
  roundId: z.uuid(),
  number: z.int().positive(),
  host: passportAdaptationSchema.shape.host,
  openedAt: z.iso.datetime({ offset: true }),
  genomeBefore: genome,
  candidates: z.array(
    z.object({
      id: z.string(),
      genome,
      effect: z.string(),
      tradeOff: z.string(),
      source: z.enum(['generated', 'dormant']),
    }),
  ),
  mutationSelection: z.object({ choiceId: z.string().nullable() }).nullable(),
  participantGenome: genome.nullable(),
  studioHatch: z.object({ hash: z.string() }).nullable().optional(),
  studioCommitted: z.boolean().optional(),
});
const same = (a: z.infer<typeof genome>, b: z.infer<typeof genome>) =>
  a.pulse === b.pulse && a.calm === b.calm && a.grit === b.grit && a.drift === b.drift;

/**
 * The selection comes from recorded data only: the version-one selection captured at close,
 * otherwise the participant genome captured at close matched against the recorded cards (each
 * card differs from the prior genome and from each other, so a match is unambiguous).
 */
export function recordedSelection(
  saved: z.infer<typeof savedAdaptationSchema>,
): PassportAdaptation['selection'] {
  const card = (candidate: z.infer<typeof savedAdaptationSchema>['candidates'][number]) => ({
    status: 'selected' as const,
    effect: candidate.effect,
    tradeOff: candidate.tradeOff,
    source: candidate.source,
    genomeAfter: candidate.genome,
  });
  if (saved.studioHatch !== null && saved.studioHatch !== undefined)
    return {
      status: 'studio',
      hash: saved.studioHatch.hash,
      committed: saved.studioCommitted === true,
      genomeAfter: saved.participantGenome,
    };
  if (saved.mutationSelection !== null) {
    if (saved.mutationSelection.choiceId === null) return { status: 'hold' };
    const chosen = saved.candidates.find((item) => item.id === saved.mutationSelection?.choiceId);
    if (chosen === undefined) throw new Error('Recorded selection is not a recorded card.');
    return card(chosen);
  }
  if (saved.participantGenome === null) return { status: 'unrecorded' };
  if (same(saved.participantGenome, saved.genomeBefore)) return { status: 'hold' };
  const after = saved.participantGenome,
    matches = saved.candidates.filter((item) => same(item.genome, after));
  if (matches.length !== 1 || matches[0] === undefined)
    throw new Error('Recorded participant genome does not match exactly one recorded card.');
  return card(matches[0]);
}

const host = (alias: string) =>
  `jsonb_build_object('channelId',${alias}.id,'label',${alias}.label)`;

export async function readPassport(
  pool: pg.Pool,
  scope: WorldScope,
  organismId: string,
  adaptationsBefore?: number,
): Promise<Passport | null> {
  const row = (
    await pool.query<{ payload: unknown }>(
      `select jsonb_build_object('schemaVersion',1,'worldId',w.id,'mode',w.mode,
    'organism',jsonb_build_object('id',o.id,'name',o.name,'lineageId',o.lineage_id,'generation',o.generation,'status',o.status,'health',o.health,
      'genome',jsonb_build_object('pulse',o.pulse,'calm',o.calm,'grit',o.grit,'drift',o.drift),'foundingGenome',o.founding_genome,
      'appearance',o.appearance,'appearanceMapping',o.appearance_mapping,'createdAt',o.created_at),
    'origin',${organismOriginSql},'hosts',${organismHostsSql},
    'parent',(select jsonb_build_object('id',p.id,'name',p.name,'status',p.status) from organisms p where p.world_id=o.world_id and p.id=o.parent_id),
    'founder',(select jsonb_build_object('id',f.id,'name',f.name,'status',f.status) from organisms f where f.world_id=o.world_id and f.id=o.founder_id),
    'residencies',coalesce((select jsonb_agg(${host('c')}||jsonb_build_object('role',r.role,'startedAt',r.started_at,'endedAt',r.ended_at) order by r.started_at,r.id)
      from residencies r join channels c on c.world_id=r.world_id and c.id=r.channel_id where r.world_id=o.world_id and r.organism_id=o.id),'[]'::jsonb),
    'birth',(select jsonb_build_object('transferId',t.id,'source',${host('source')},
        'destination',case when destination.id is null then null else ${host('destination')} end,
        'outcome',t.outcome,'historical',t.claimed_at is not null,'createdAt',t.created_at) from transfers t
      join channels source on source.world_id=t.world_id and source.id=t.source_channel_id
      left join channels destination on destination.world_id=t.world_id and destination.id=t.destination_channel_id
      where t.world_id=o.world_id and t.child_id=o.id order by t.created_at,t.id limit 1),
    'adaptations',jsonb_build_object(
      'total',(select count(*) from rounds r where r.world_id=o.world_id and r.organism_id=o.id and r.kind='MUTATION' and r.close_sequence is not null),
      'items',coalesce((select jsonb_agg(item order by number desc) from (
        select r.number,jsonb_build_object('roundId',r.id,'number',r.number,'host',${host('c')},'openedAt',r.opened_at,
          'genomeBefore',r.checkpoint->'genomeBefore','candidates',r.checkpoint->'candidates','mutationSelection',r.checkpoint->'mutationSelection','studioHatch',r.checkpoint->'studioHatch',
          'studioCommitted',exists(select 1 from pending_adaptations pa where pa.world_id=r.world_id and pa.committed_round_id=r.id and pa.status='committed'),
          'participantGenome',(select p.genome from round_participants p where p.world_id=r.world_id and p.round_id=r.id and p.organism_id=o.id)) as item
        from rounds r join channels c on c.world_id=r.world_id and c.id=r.channel_id
        where r.world_id=o.world_id and r.organism_id=o.id and r.kind='MUTATION' and r.close_sequence is not null
          and ($4::int is null or r.number<$4) order by r.number desc limit $5) page),'[]'::jsonb)),
    'dormant',jsonb_build_object(
      'total',(select count(*) from dormant_mutations d where d.world_id=o.world_id and d.organism_id=o.id),
      'items',coalesce((select jsonb_agg(item order by opened_at desc,id) from (
        select sr.opened_at,d.id,jsonb_build_object('id',d.id,'sourceRoundId',d.source_round_id,'origin',${host('dc')},'template',d.template,
          'supporters',d.provenance->'supporters','totalVotes',d.provenance->'totalVotes','status',d.status,'offered',d.offered,
          'inherited',d.provenance ? 'inheritedFrom','remainingRounds',d.remaining_rounds,'outcome',d.consumption->'reason') as item
        from dormant_mutations d join rounds sr on sr.world_id=d.world_id and sr.id=d.source_round_id
        join channels dc on dc.world_id=d.world_id and dc.id=(d.provenance->>'originChannelId')::uuid
        where d.world_id=o.world_id and d.organism_id=o.id order by sr.opened_at desc,d.id limit $6) page),'[]'::jsonb)),
    'traces',jsonb_build_object(
      'total',(select count(*) from habitat_traces t where t.world_id=o.world_id and t.emitter_id=o.id),
      'items',coalesce((select jsonb_agg(item order by opened_at desc,id) from (
        select q.opened_at,t.id,jsonb_build_object('id',t.id,'template',t.template,'status',t.status,'remainingRounds',t.remaining_rounds,
          'qualifyingRoundId',t.qualifying_round_id,'host',${host('tc')}) as item
        from habitat_traces t join rounds q on q.world_id=t.world_id and q.id=t.qualifying_round_id
        join channels tc on tc.world_id=t.world_id and tc.id=t.channel_id
        where t.world_id=o.world_id and t.emitter_id=o.id order by q.opened_at desc,t.id limit $6) page),'[]'::jsonb)),
    'ancestorTrials',jsonb_build_object(
      'total',(select count(*) from ancestor_trials a where a.world_id=o.world_id and a.organism_id=o.id),
      'items',coalesce((select jsonb_agg(item order by opened_at desc,round_id) from (
        select r.opened_at,a.round_id,jsonb_build_object('roundId',a.round_id,'number',r.number,'host',${host('ac')},'ancestorId',a.ancestor_id,
          'identicalGenome',a.result->'identicalGenome','fitnessDifference',a.result->'fitnessDifference','deltaDifference',a.result->'deltaDifference') as item
        from ancestor_trials a join rounds r on r.world_id=a.world_id and r.id=a.round_id
        join channels ac on ac.world_id=r.world_id and ac.id=r.channel_id
        where a.world_id=o.world_id and a.organism_id=o.id order by r.opened_at desc,a.round_id limit $6) page),'[]'::jsonb))
  ) as payload
  from organisms o join lineages l on l.world_id=o.world_id and l.id=o.lineage_id join worlds w on w.id=o.world_id
  where o.world_id=$1 and o.id=$3 and (w.expires_at is null or w.expires_at>clock_timestamp()) and ${lineageVisibleSql}`,
      [
        scope.worldId,
        scope.channelId,
        organismId,
        adaptationsBefore ?? null,
        PASSPORT_ADAPTATION_PAGE + 1,
        PASSPORT_RECORD_LIMIT,
      ],
    )
  ).rows[0];
  if (row === undefined) return null;
  const saved = passportSchema
      .omit({ organism: true, adaptations: true, hosts: true })
      .extend({
        organism: passportSchema.shape.organism
          .omit({ appearanceMapping: true, marks: true })
          .extend({
            appearanceMapping: z.unknown(),
          }),
        hosts: z.unknown(),
        adaptations: z.object({
          total: z.int().nonnegative(),
          items: z.array(savedAdaptationSchema).max(PASSPORT_ADAPTATION_PAGE + 1),
        }),
      })
      .parse(row.payload),
    { appearanceMapping, ...organism } = saved.organism,
    provenance = organismAppearanceProvenance(
      { appearanceMapping, origin: saved.origin, hosts: saved.hosts },
      { includeHosts: true },
    ),
    page = saved.adaptations.items.slice(0, PASSPORT_ADAPTATION_PAGE),
    last = page.at(-1);
  return passportSchema.parse({
    ...saved,
    organism: {
      ...organism,
      appearanceMapping: provenance.appearanceMapping,
      marks: provenance.marks,
    },
    hosts: provenance.hosts,
    adaptations: {
      total: saved.adaptations.total,
      items: page.map((item) => ({
        roundId: item.roundId,
        number: item.number,
        host: item.host,
        openedAt: item.openedAt,
        genomeBefore: item.genomeBefore,
        selection: recordedSelection(item),
      })),
      next:
        saved.adaptations.items.length > PASSPORT_ADAPTATION_PAGE && last !== undefined
          ? String(last.number)
          : null,
    },
  });
}
