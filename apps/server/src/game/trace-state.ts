import {
  consumeValidRound,
  newValidRoundLifetime,
  qualifiesForTrace,
  traceTemplateFor,
  type RoundCheckpoint,
  type TraceChoice,
  type TraceTemplate,
  type ValidRoundLifetime,
} from '@ripple/engine';
import { genomeOf, type GameContext, type OrganismRow } from './store.ts';
import { operationId } from './operation-id.ts';

export interface TraceRow {
  id: string;
  channel_id: string;
  emitter_id: string;
  qualifying_round_id: string;
  template: TraceTemplate;
  status: 'pending' | 'active' | 'cleared' | 'expired' | 'replaced' | 'rejected';
  version: number;
  remaining_rounds: number;
  lifetime: ValidRoundLifetime;
  decision: Readonly<Record<string, unknown>>;
  provenance: Readonly<Record<string, unknown>>;
}
export function traceReference(row: TraceRow): NonNullable<RoundCheckpoint['activeTrace']> {
  return { id: row.id, version: row.version, template: row.template };
}
export async function activeTrace(context: GameContext): Promise<RoundCheckpoint['activeTrace']> {
  if (context.mechanics.version !== 1 || !context.mechanics.tracesEnabled) return undefined;
  const row = (
    await context.client.query<TraceRow>(
      "select t.* from habitat_traces t join trace_qualifications q on q.world_id=t.world_id and q.trace_id=t.id where t.world_id=$1 and t.channel_id=$2 and t.status='active'",
      [context.channel.world_id, context.channel.id],
    )
  ).rows[0];
  return row === undefined ? null : traceReference(row);
}
export async function pendingTrace(context: GameContext): Promise<TraceRow | null> {
  if (context.mechanics.version !== 1 || !context.mechanics.tracesEnabled) return null;
  return (
    (
      await context.client.query<TraceRow>(
        `select t.* from habitat_traces t join rounds r on r.world_id=t.world_id and r.id=t.qualifying_round_id
       join trace_qualifications q on q.world_id=t.world_id and q.trace_id=t.id
     where t.world_id=$1 and t.channel_id=$2 and t.status='pending' and t.remaining_rounds>0 order by r.number,t.id limit 1`,
        [context.channel.world_id, context.channel.id],
      )
    ).rows[0] ?? null
  );
}

/** Qualification happens after extinction and contest settlement, including former visitors now resident. */
export async function qualifyHabitatTraces(
  context: GameContext,
  sequence: number,
): Promise<readonly string[]> {
  if (context.mechanics.version !== 1) return [];
  const { client, channel, round, rules } = context;
  if (round === null) throw new Error('Missing trace qualification round.');
  const candidates = (
    await client.query<
      OrganismRow & {
        lineage_id: string;
        origin_channel_id: string;
        residency_id: string;
        completed_valid_rounds: number;
        trace_qualified: boolean;
        already_qualified: boolean;
      }
    >(
      `select o.*,l.origin_channel_id,r.id as residency_id,r.completed_valid_rounds,r.trace_qualified,
      exists(select 1 from trace_qualifications q where q.world_id=o.world_id and q.lineage_id=o.lineage_id and q.channel_id=$2) as already_qualified
     from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id join lineages l on l.world_id=o.world_id and l.id=o.lineage_id
     join round_participants p on p.world_id=o.world_id and p.organism_id=o.id and p.round_id=$3
     where r.world_id=$1 and r.channel_id=$2 and r.ended_at is null and r.role in ('resident','visitor')
     and r.arrival_snapshot is not null and o.parent_id is not null and o.status='ALIVE' and p.resolution->>'outcome'='applied' order by o.id`,
      [channel.world_id, channel.id, round.id],
    )
  ).rows;
  const emitted: string[] = [];
  for (const candidate of candidates) {
    if (
      !qualifiesForTrace(
        {
          raidOrigin: true,
          validSurvivingRounds: candidate.completed_valid_rounds,
          qualifiedThisResidency: candidate.trace_qualified,
          lineageQualifiedAtHostThisSeason: candidate.already_qualified,
        },
        rules,
      )
    )
      continue;
    const id = operationId(channel.id, sequence, `trace:${candidate.residency_id}`),
      template = traceTemplateFor(genomeOf(candidate), rules);
    const lifetime = newValidRoundLifetime(round.id, context.mechanics.policy.pendingTraceRounds);
    const enabled = context.mechanics.tracesEnabled;
    await client.query(
      `insert into habitat_traces(world_id,id,channel_id,emitter_id,template,status,remaining_rounds,version,decision,provenance,lifetime,qualifying_round_id)
       values($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11)`,
      [
        channel.world_id,
        id,
        channel.id,
        candidate.id,
        template,
        enabled ? 'pending' : 'rejected',
        enabled ? lifetime.remainingRounds : 0,
        { reason: enabled ? 'awaiting-vote' : 'traces-disabled', sequence },
        {
          lineageId: candidate.lineage_id,
          originChannelId: candidate.origin_channel_id,
          residencyId: candidate.residency_id,
          qualifyingRoundId: round.id,
          genome: genomeOf(candidate),
          sequence,
        },
        enabled ? lifetime : { ...lifetime, remainingRounds: 0 },
        round.id,
      ],
    );
    await client.query(
      `insert into trace_qualifications(world_id,lineage_id,channel_id,residency_id,emitter_id,qualifying_round_id,trace_id) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        channel.world_id,
        candidate.lineage_id,
        channel.id,
        candidate.residency_id,
        candidate.id,
        round.id,
        id,
      ],
    );
    await client.query('update residencies set trace_qualified=true where world_id=$1 and id=$2', [
      channel.world_id,
      candidate.residency_id,
    ]);
    emitted.push(id);
  }
  return emitted;
}

export async function decideHabitatTrace(
  context: GameContext,
  choice: TraceChoice,
  counts: readonly number[],
  sequence: number,
): Promise<RoundCheckpoint['activeTrace']> {
  const { client, channel, round } = context,
    offer = round?.checkpoint.specialBallot?.traceOffer;
  if (round === null || offer === undefined) throw new Error('Missing captured trace offer.');
  const row = (
    await client.query<TraceRow>(
      "select * from habitat_traces where world_id=$1 and id=$2 and channel_id=$3 and status='pending' and version=$4",
      [channel.world_id, offer.id, channel.id, offer.version],
    )
  ).rows[0];
  if (row === undefined || !context.mechanics.tracesEnabled)
    throw new Error('Trace offer changed before its decision.');
  if (choice === 'keep') {
    const previous = (
      await client.query<TraceRow>(
        "select * from habitat_traces where world_id=$1 and channel_id=$2 and status='active'",
        [channel.world_id, channel.id],
      )
    ).rows[0];
    if (previous !== undefined)
      await client.query(
        "update habitat_traces set status='replaced',remaining_rounds=0,lifetime=$3,decision=$4,version=version+1 where world_id=$1 and id=$2",
        [
          channel.world_id,
          previous.id,
          { ...previous.lifetime, remainingRounds: 0 },
          {
            ...previous.decision,
            terminal: { reason: 'replaced', byTraceId: row.id, roundId: round.id, sequence },
          },
        ],
      );
  }
  const lifetime =
    choice === 'keep'
      ? newValidRoundLifetime(row.qualifying_round_id, context.mechanics.policy.traceRounds)
      : { ...row.lifetime, remainingRounds: 0 };
  await client.query(
    'update habitat_traces set status=$3,remaining_rounds=$4,lifetime=$5,decision=$6,version=version+1 where world_id=$1 and id=$2',
    [
      channel.world_id,
      row.id,
      choice === 'keep' ? 'active' : 'cleared',
      lifetime.remainingRounds,
      lifetime,
      { choice, counts, roundId: round.id, sequence },
    ],
  );
  return activeTrace(context);
}

/** One confident host interval consumes one allowance, regardless of how many real organisms shared it. */
export async function ageHabitatTraces(
  context: GameContext,
  valid: boolean,
  sequence: number,
): Promise<readonly string[]> {
  if (context.mechanics.version !== 1 || !valid) return [];
  const { client, channel, round } = context;
  if (round === null) throw new Error('Missing trace lifetime round.');
  const rows = (
    await client.query<TraceRow>(
      "select * from habitat_traces where world_id=$1 and channel_id=$2 and status in ('pending','active') order by id",
      [channel.world_id, channel.id],
    )
  ).rows;
  const changed: string[] = [];
  for (const row of rows) {
    const lifetime = consumeValidRound(row.lifetime, round.id, true);
    if (lifetime === row.lifetime) continue;
    const expired = lifetime.remainingRounds === 0;
    await client.query(
      'update habitat_traces set remaining_rounds=$3,lifetime=$4,status=$5,decision=$6,version=version+1 where world_id=$1 and id=$2',
      [
        channel.world_id,
        row.id,
        lifetime.remainingRounds,
        lifetime,
        expired ? 'expired' : row.status,
        expired
          ? {
              ...row.decision,
              terminal: { reason: 'valid-round-expiry', roundId: round.id, sequence },
            }
          : row.decision,
      ],
    );
    changed.push(row.id);
  }
  return changed;
}
