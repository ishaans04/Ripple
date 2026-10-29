import {
  finishRoundObservation,
  resolveVisitorContest,
  type ActivityObservation,
  type RoundCheckpoint,
  type RoundResolution,
  type OutcomeExplanation,
} from '@ripple/engine';
import type { GameContext, OrganismRow } from './store.ts';
import { genomeOf } from './store.ts';
import { loadRaidPolicy, readTransfer, recordTransferTransition } from './propagation-store.ts';
import { recordAncestorTrial } from './ancestor-trials.ts';
import { recordChoiceReplay } from './choice-replays.ts';

/** Captures the same observation boundary for the resident and an already welcomed visitor. */
export async function captureRoundParticipants(context: GameContext): Promise<void> {
  if (context.round === null) throw new Error('Cannot capture an absent round');
  await context.client.query(
    `insert into round_participants(world_id,round_id,organism_id,role,genome,health_before)
    select r.world_id,$3,o.id,r.role,jsonb_build_object('pulse',o.pulse,'calm',o.calm,'grit',o.grit,'drift',o.drift),o.health
    from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id left join visitor_state v on v.world_id=o.world_id and v.organism_id=o.id
    where r.world_id=$1 and r.channel_id=$2 and r.ended_at is null and o.status='ALIVE' and (r.role='resident' or (r.role='visitor' and v.welcomed)) on conflict do nothing`,
    [context.channel.world_id, context.channel.id, context.round.id],
  );
}
export async function lockParticipantLineages(context: GameContext): Promise<void> {
  await context.client.query(
    `select l.id from lineages l where l.world_id=$1 and l.id in (select o.lineage_id from organisms o join residencies r on r.world_id=o.world_id and r.organism_id=o.id where r.world_id=$1 and r.channel_id=$2 and r.ended_at is null and r.role in ('resident','visitor')) order by l.id for update`,
    [context.channel.world_id, context.channel.id],
  );
}
export async function participantCheckpoint(
  context: GameContext,
  organismId: string,
  base: RoundCheckpoint,
): Promise<RoundCheckpoint> {
  const arrival = (
    await context.client.query<{ shock_reduction: number }>(
      `select v.shock_reduction from visitor_state v join residencies r on r.world_id=v.world_id and r.organism_id=v.organism_id where v.world_id=$1 and v.organism_id=$2 and v.channel_id=$3 and v.arrival_pending and v.welcomed and r.ended_at is null`,
      [context.channel.world_id, organismId, context.channel.id],
    )
  ).rows[0];
  return arrival === undefined
    ? base
    : {
        ...base,
        shocks: [
          ...base.shocks,
          {
            kind: 'arrival',
            amount: Math.max(0, context.rules.shock.arrival - arrival.shock_reduction),
          },
        ],
      };
}
async function saveResolution(
  context: GameContext,
  organismId: string,
  resolution: RoundResolution,
  explanation: OutcomeExplanation,
  checkpoint: RoundCheckpoint,
): Promise<void> {
  if (context.round === null) throw new Error('Missing participant round');
  await context.client.query(
    'update round_participants set resolution=$4,explanation=$5 where world_id=$1 and round_id=$2 and organism_id=$3 and resolution is null',
    [
      context.channel.world_id,
      context.round.id,
      organismId,
      JSON.stringify(resolution),
      JSON.stringify(explanation),
    ],
  );
  await recordAncestorTrial(context, organismId, checkpoint, resolution);
  await recordChoiceReplay(context, organismId, checkpoint, resolution);
  if (resolution.outcome === 'applied')
    await context.client.query(
      'update visitor_state set arrival_pending=false where world_id=$1 and organism_id=$2',
      [context.channel.world_id, organismId],
    );
}
async function fossilize(context: GameContext, id: string, atMs: number): Promise<void> {
  await context.client.query(
    "update organisms set status='FOSSIL',version=version+1 where world_id=$1 and id=$2 and status='ALIVE'",
    [context.channel.world_id, id],
  );
  await context.client.query(
    'update residencies set ended_at=$3 where world_id=$1 and organism_id=$2 and ended_at is null',
    [context.channel.world_id, id, new Date(atMs)],
  );
}
export async function finishVisitorObservation(
  context: GameContext,
  observations: readonly ActivityObservation[],
  primaryResolution: RoundResolution,
  primaryExplanation: OutcomeExplanation,
  primaryCheckpoint: RoundCheckpoint,
  sequence: number,
  atMs: number,
): Promise<Readonly<Record<string, unknown>> | null> {
  const { client, channel, round, rules } = context,
    primary = context.organism;
  if (round === null || primary === null) throw new Error('Missing primary observation');
  await saveResolution(
    context,
    primary.id,
    primaryResolution,
    primaryExplanation,
    primaryCheckpoint,
  );
  const visitor = (
    await client.query<OrganismRow & { transfer_id: string; shelter_pending: boolean }>(
      `select o.*,v.transfer_id,v.shelter_pending from visitor_state v join residencies r on r.world_id=v.world_id and r.organism_id=v.organism_id join organisms o on o.world_id=v.world_id and o.id=v.organism_id
    where v.world_id=$1 and v.channel_id=$2 and v.organism_id<>$3 and v.welcomed and r.role='visitor' and r.ended_at is null and o.status='ALIVE'`,
      [channel.world_id, channel.id, primary.id],
    )
  ).rows[0];
  if (visitor === undefined) return null;
  const checkpoint = await participantCheckpoint(context, visitor.id, round.checkpoint);
  const finished = finishRoundObservation(
      {
        checkpoint,
        genome: genomeOf(visitor),
        health: visitor.health,
        slots: visitor.mutation_slots,
        observations,
      },
      rules,
    ),
    resolution = finished.resolution;
  if (resolution.outcome === 'interrupted' || primaryResolution.outcome === 'interrupted')
    throw new Error('Untrustworthy interval reached visitor scoring');
  await saveResolution(context, visitor.id, resolution, finished.explanation, checkpoint);
  await client.query(
    'update organisms set health=$3,status=$4,mutation_slots=$5,version=version+1 where world_id=$1 and id=$2',
    [
      channel.world_id,
      visitor.id,
      resolution.healthAfter,
      resolution.healthAfter === 0 ? 'FOSSIL' : 'ALIVE',
      JSON.stringify(finished.slots),
    ],
  );
  if (resolution.outcome === 'applied')
    await client.query(
      'update residencies set completed_valid_rounds=completed_valid_rounds+1 where world_id=$1 and organism_id=$2 and ended_at is null',
      [channel.world_id, visitor.id],
    );
  const policy = await loadRaidPolicy(client, channel.world_id);
  const contest = resolveVisitorContest(
    {
      confidence:
        primaryResolution.outcome === 'applied' && resolution.outcome === 'applied'
          ? 'confident'
          : 'limited',
      residentHealth: primaryResolution.healthAfter,
      visitorHealth: resolution.healthAfter,
      residentFitness:
        primaryResolution.outcome === 'applied' ? primaryResolution.score.fitness : null,
      visitorFitness: resolution.outcome === 'applied' ? resolution.score.fitness : 0,
      shelterPending: visitor.shelter_pending,
    },
    policy,
  );
  const transfer = await readTransfer(client, channel.world_id, visitor.transfer_id);
  if (transfer === null) throw new Error('Missing active visitor transfer');
  if (contest.outcome === 'sheltered') {
    await client.query(
      'update organisms set health=$3,version=version+1 where world_id=$1 and id=$2',
      [channel.world_id, primary.id, contest.residentHealth],
    );
    await client.query(
      'update organisms set health=$3,version=version+1 where world_id=$1 and id=$2',
      [channel.world_id, visitor.id, contest.visitorHealth],
    );
    await client.query(
      'update visitor_state set shelter_pending=false where world_id=$1 and organism_id=$2',
      [channel.world_id, visitor.id],
    );
    context.organism = {
      ...primary,
      health: contest.residentHealth ?? primary.health,
      version: primary.version + 1,
    };
    await recordTransferTransition(client, transfer, 'ACTIVE', channel.id, sequence, atMs, {
      sheltered: true,
      moved: contest.moved,
    });
  } else if (contest.outcome === 'visitor') {
    await fossilize(context, primary.id, atMs);
    await client.query(
      "update residencies set role='resident' where world_id=$1 and organism_id=$2 and role='visitor' and ended_at is null",
      [channel.world_id, visitor.id],
    );
    context.organism =
      (
        await client.query<OrganismRow>('select * from organisms where world_id=$1 and id=$2', [
          channel.world_id,
          visitor.id,
        ])
      ).rows[0] ?? null;
    await recordTransferTransition(client, transfer, 'VISITOR_WON', channel.id, sequence, atMs, {
      residentId: visitor.id,
      fossilId: primary.id,
    });
  } else if (contest.outcome === 'resident' || contest.outcome === 'empty') {
    await fossilize(context, visitor.id, atMs);
    if (contest.outcome === 'empty') await fossilize(context, primary.id, atMs);
    await recordTransferTransition(
      client,
      transfer,
      contest.outcome === 'empty' ? 'BOTH_EXTINCT' : 'VISITOR_LOST',
      channel.id,
      sequence,
      atMs,
      { residentId: contest.outcome === 'empty' ? null : primary.id, fossilId: visitor.id },
    );
  }
  const result = { visitorId: visitor.id, resolution, explanation: finished.explanation, contest };
  await client.query('update rounds set visitor_result=$3 where world_id=$1 and id=$2', [
    channel.world_id,
    round.id,
    JSON.stringify(result),
  ]);
  return result;
}
