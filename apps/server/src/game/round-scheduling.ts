import {
  nextBallot,
  openMutationRound,
  openSpecialRound,
  preparationOptions,
  preparationSchema,
  resolveSpecialVote,
  welcomeArrival,
  welcomeChoiceSchema,
  welcomeOptions,
  type BallotVote,
  type BaselineRound,
  type RoundClock,
} from '@ripple/engine';
import { captureRoundParticipants } from './visitor-observation.ts';
import { effect, type CommandEffect } from './lifecycle.ts';
import { genomeOf, saveCheckpoint, type GameContext, type OrganismRow } from './store.ts';
import { loadRaidPolicy, readTransfer, recordTransferTransition } from './propagation-store.ts';

/** Runs only after the previous round has committed its completion, or on an empty channel. */
export async function openNextRound(
  context: GameContext,
  roundId: string,
  atMs: number,
): Promise<boolean> {
  const { client, channel, rules, timings } = context;
  if (!channel.online || !channel.healthy || channel.paused) return false;
  const actor = (
    await client.query<OrganismRow>(
      `select o.* from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id where r.world_id=$1 and r.channel_id=$2 and r.ended_at is null and r.role in ('resident','visitor') and o.status='ALIVE' order by case when r.role='resident' then 0 else 1 end,o.id limit 1`,
      [channel.world_id, channel.id],
    )
  ).rows[0];
  if (actor === undefined) {
    context.organism = null;
    return false;
  }
  context.organism = actor;
  const resident = (
    await client.query<OrganismRow>(
      `select o.* from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id where r.world_id=$1 and r.channel_id=$2 and r.ended_at is null and r.role='resident' and o.status='ALIVE'`,
      [channel.world_id, channel.id],
    )
  ).rows[0];
  const visitor = (
    await client.query<{ organism_id: string }>(
      `select v.organism_id from visitor_state v join residencies r on r.world_id=v.world_id and r.organism_id=v.organism_id where v.world_id=$1 and v.channel_id=$2 and not v.welcomed and r.role='visitor' and r.ended_at is null`,
      [channel.world_id, channel.id],
    )
  ).rows[0];
  const play = (
    await client.query<{ preparation_requested: boolean; non_mutation_rounds: number }>(
      'select preparation_requested,non_mutation_rounds from channel_play where world_id=$1 and channel_id=$2',
      [channel.world_id, channel.id],
    )
  ).rows[0];
  if (play === undefined) throw new Error('Missing channel ballot scheduler');
  const kind = nextBallot({
    pendingWelcome: visitor !== undefined,
    pendingTrace: false,
    preparationRequested: resident !== undefined && play.preparation_requested,
    nonMutationRounds: play.non_mutation_rounds,
  });
  const history = await client.query<{ round_id: string; contributions: number; burst: number }>(
    'select round_id,contributions,burst from habitat_baselines where world_id=$1 and channel_id=$2 order by completed_at desc,round_id desc limit $3',
    [channel.world_id, channel.id, rules.baseline.windowRounds],
  );
  const baseline: BaselineRound[] = history.rows.reverse().map((r) => ({
    roundId: r.round_id,
    contributions: r.contributions,
    burst: r.burst,
    confidence: 'confident',
  }));
  const input = {
    seed: channel.seed,
    roundId,
    genome: genomeOf(actor),
    history: baseline,
    atMs,
    timings,
  };
  const checkpoint =
    kind === 'MUTATION'
      ? openMutationRound(input, rules)
      : openSpecialRound(
          {
            ...input,
            kind,
            options:
              kind === 'WELCOME'
                ? welcomeOptions(
                    resident?.health ?? null,
                    await loadRaidPolicy(client, channel.world_id),
                  )
                : preparationOptions,
            ...(visitor === undefined ? {} : { visitorId: visitor.organism_id }),
          },
          rules,
        );
  const number = (
    await client.query<{ number: number }>(
      'select coalesce(max(number),0)+1 as number from rounds where world_id=$1 and channel_id=$2',
      [channel.world_id, channel.id],
    )
  ).rows[0]?.number;
  if (number === undefined) throw new Error('Cannot allocate round number');
  await client.query(
    `insert into rounds(world_id,id,channel_id,organism_id,number,kind,phase,rules_hash,seed,checkpoint,opened_at) values($1,$2,$3,$4,$5,$6,'VOTING',$7,$8,$9,$10)`,
    [
      channel.world_id,
      roundId,
      channel.id,
      actor.id,
      number,
      kind,
      channel.rules_hash,
      channel.seed,
      JSON.stringify(checkpoint),
      new Date(atMs),
    ],
  );
  await client.query(
    'update channel_play set non_mutation_rounds=case when $3 then 0 else non_mutation_rounds+1 end,preparation_requested=case when $4 then false else preparation_requested end where world_id=$1 and channel_id=$2',
    [channel.world_id, channel.id, kind === 'MUTATION', kind === 'PREPARATION'],
  );
  context.round = {
    id: roundId,
    number,
    organism_id: actor.id,
    phase: 'VOTING',
    checkpoint,
    completed_at: null,
  };
  return true;
}
export async function requestPreparation(context: GameContext): Promise<CommandEffect> {
  const { client, channel, round } = context;
  const resident = await client.query(
    "select 1 from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id where r.world_id=$1 and r.channel_id=$2 and r.role='resident' and r.ended_at is null and o.status='ALIVE'",
    [channel.world_id, channel.id],
  );
  if (resident.rowCount !== 1) return effect('NO_RESIDENT');
  if (round?.checkpoint.specialBallot?.kind === 'PREPARATION') return effect('NO_CHANGE');
  const changed = await client.query(
    'update channel_play set preparation_requested=true where world_id=$1 and channel_id=$2 and not preparation_requested',
    [channel.world_id, channel.id],
  );
  return effect(
    changed.rowCount === 1 ? 'APPLIED' : 'NO_CHANGE',
    changed.rowCount === 1 ? 'preparation.requested' : null,
  );
}
export async function closeSpecialBallot(
  context: GameContext,
  votes: readonly BallotVote[],
  sequence: number,
  atMs: number,
  clock: RoundClock,
): Promise<CommandEffect> {
  const { client, channel, round, rules } = context,
    special = round?.checkpoint.specialBallot;
  if (round === null || special === undefined) throw new Error('Missing captured special ballot');
  const policy = await loadRaidPolicy(client, channel.world_id);
  const standing = preparationSchema.parse(
    (
      await client.query<{ preparation: string }>(
        'select preparation from channel_play where world_id=$1 and channel_id=$2',
        [channel.world_id, channel.id],
      )
    ).rows[0]?.preparation,
  );
  const resolved = resolveSpecialVote(
    special.options,
    votes,
    special.kind === 'PREPARATION' ? standing : 'conserve',
  );
  if (special.kind === 'PREPARATION')
    await client.query(
      'update channel_play set preparation=$3 where world_id=$1 and channel_id=$2',
      [channel.world_id, channel.id, preparationSchema.parse(resolved.choice)],
    );
  else {
    const visitor = (
      await client.query<OrganismRow & { transfer_id: string; shock_reduction: number }>(
        `select o.*,v.transfer_id,v.shock_reduction from visitor_state v join organisms o on o.world_id=v.world_id and o.id=v.organism_id join residencies r on r.world_id=o.world_id and r.organism_id=o.id where v.world_id=$1 and v.channel_id=$2 and v.organism_id=$3 and r.role='visitor' and r.ended_at is null and o.status='ALIVE' and not v.welcomed`,
        [channel.world_id, channel.id, special.visitorId],
      )
    ).rows[0];
    if (visitor === undefined) throw new Error('Welcome subject is no longer eligible');
    const arrival = welcomeArrival(
      visitor.health,
      welcomeChoiceSchema.parse(resolved.choice),
      visitor.shock_reduction,
      rules,
      policy,
    );
    await client.query(
      'update organisms set health=$3,version=version+1 where world_id=$1 and id=$2',
      [channel.world_id, visitor.id, arrival.health],
    );
    await client.query(
      'update visitor_state set welcomed=true,shelter_pending=$3,shock_reduction=$4 where world_id=$1 and organism_id=$2',
      [channel.world_id, visitor.id, arrival.shelterPending, arrival.shockReduction],
    );
    const resident = await client.query(
      "select 1 from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id where r.world_id=$1 and r.channel_id=$2 and r.role='resident' and r.ended_at is null and o.status='ALIVE'",
      [channel.world_id, channel.id],
    );
    if (resident.rowCount === 0) {
      await client.query(
        "update residencies set role='resident' where world_id=$1 and organism_id=$2 and ended_at is null",
        [channel.world_id, visitor.id],
      );
      const transfer = await readTransfer(client, channel.world_id, visitor.transfer_id);
      if (transfer === null) throw new Error('Missing welcome transfer');
      await recordTransferTransition(
        client,
        transfer,
        'RESIDENT_ESTABLISHED',
        channel.id,
        sequence,
        atMs,
        { choice: resolved.choice },
      );
    }
    if (context.organism?.id === visitor.id)
      context.organism = { ...visitor, health: arrival.health, version: visitor.version + 1 };
  }
  await client.query('update rounds set close_sequence=$3 where world_id=$1 and id=$2', [
    channel.world_id,
    round.id,
    sequence,
  ]);
  await saveCheckpoint(context, { ...round.checkpoint, clock, counts: resolved.counts });
  await captureRoundParticipants(context);
  return effect('APPLIED', 'ballot.closed', {
    roundId: round.id,
    kind: special.kind,
    choiceId: resolved.choice,
    counts: resolved.counts,
    genesUnchanged: true,
  });
}
