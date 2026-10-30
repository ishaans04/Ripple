import { APPEARANCE_MAPPING_VERSION, type GameCommand } from '@ripple/contracts';
import {
  activeElapsed,
  advanceRoundClock,
  categoryChangeShock,
  closeMutationRound,
  finishRoundObservation,
  founderAppearance,
  initialMutationSlots,
  type BallotVote,
} from '@ripple/engine';
import { openNextRound, closeSpecialBallot } from './round-scheduling.ts';
import { effect, type CommandEffect } from './lifecycle.ts';
import {
  captureRoundParticipants,
  participantCheckpoint,
  finishVisitorObservation,
  lockParticipantLineages,
} from './visitor-observation.ts';
import { gameHeld, genomeOf, saveCheckpoint, type GameContext } from './store.ts';
import {
  captureDormantMutation,
  ageDormantMutations,
  consumeDormantOffer,
} from './dormant-state.ts';
import { ageHabitatTraces, qualifyHabitatTraces } from './trace-state.ts';
import { commitStudioHatch, settleStudioAfterObservation } from './studio-hatch.ts';

export { openNextRound } from './round-scheduling.ts';
export async function seedResident(
  context: GameContext,
  command: Extract<GameCommand, { type: 'seed' }>,
  atMs: number,
): Promise<CommandEffect> {
  const { channel, client, rules } = context;
  if (context.organism !== null) return effect('RESIDENT_EXISTS');
  if (!channel.online || !channel.healthy) return effect('INTEGRATION_UNAVAILABLE');
  if (gameHeld(channel)) return effect('PAUSED');
  const genome = rules.genome.founder;
  await client.query(
    'insert into lineages (world_id,id,origin_channel_id,rules_hash,created_at) values ($1,$2,$3,$4,$5)',
    [channel.world_id, command.lineageId, channel.id, channel.rules_hash, new Date(atMs)],
  );
  await client.query(
    `insert into organisms (world_id,id,lineage_id,founder_id,generation,founding_genome,pulse,calm,grit,drift,health,status,appearance,mutation_slots,created_at,appearance_mapping)
    values ($1,$2,$3,$2,0,$4,$5,$6,$7,$8,$9,'ALIVE',$10,$11,$12,$13)`,
    [
      channel.world_id,
      command.organismId,
      command.lineageId,
      JSON.stringify(genome),
      genome.pulse,
      genome.calm,
      genome.grit,
      genome.drift,
      rules.health.founder,
      JSON.stringify(founderAppearance),
      JSON.stringify(initialMutationSlots),
      new Date(atMs),
      APPEARANCE_MAPPING_VERSION,
    ],
  );
  await client.query(
    `insert into residencies (world_id,id,channel_id,organism_id,role,started_at) values ($1,$2,$3,$4,'resident',$5)`,
    [channel.world_id, command.residencyId, channel.id, command.organismId, new Date(atMs)],
  );
  context.organism = {
    id: command.organismId,
    version: 0,
    ...genome,
    health: rules.health.founder,
    status: 'ALIVE',
    mutation_slots: initialMutationSlots,
    appearance: founderAppearance,
    design_version: 0,
    appearance_hash: null,
  };
  await openNextRound(context, command.roundId, atMs);
  if (command.name !== undefined)
    await client.query('update organisms set name=$3 where world_id=$1 and id=$2', [
      channel.world_id,
      command.organismId,
      command.name,
    ]);
  await client.query(
    'update twitch_channels set last_seed_at=$3 where world_id=$1 and channel_id=$2',
    [channel.world_id, channel.id, new Date(atMs)],
  );
  return effect('APPLIED', 'ballot.opened', {
    organismId: command.organismId,
    roundId: command.roundId,
  });
}
function canAccept(context: GameContext): boolean {
  return (
    context.channel.online &&
    context.channel.healthy &&
    !gameHeld(context.channel) &&
    context.round?.checkpoint.clock.paused === false &&
    context.organism?.status === 'ALIVE'
  );
}
export async function acceptVote(
  context: GameContext,
  command: Extract<GameCommand, { type: 'vote' }>,
  sequence: number,
): Promise<CommandEffect> {
  const { round, channel, client } = context;
  if (!canAccept(context) || round?.phase !== 'VOTING') return effect('NO_ACTIVE_BALLOT');
  if (command.roundId !== undefined && command.roundId !== round.id) return effect('STALE_VERSION');
  if (
    command.choice >
    (round.checkpoint.specialBallot?.options.length ?? round.checkpoint.candidates.length)
  )
    return effect('NO_ACTIVE_BALLOT');
  const inserted = await client.query(
    'insert into votes (world_id,channel_id,round_id,actor_key,choice,accepted_sequence) values ($1,$2,$3,$4,$5,$6) on conflict do nothing',
    [channel.world_id, channel.id, round.id, command.actorKey, command.choice, sequence],
  );
  if (inserted.rowCount === 0) return effect('ALREADY_VOTED');
  const counts = [...round.checkpoint.counts];
  counts[command.choice - 1] = (counts[command.choice - 1] ?? 0) + 1;
  await saveCheckpoint(context, { ...round.checkpoint, counts });
  await client.query('update rounds set vote_count=vote_count+1 where world_id=$1 and id=$2', [
    channel.world_id,
    round.id,
  ]);
  return effect('APPLIED', 'vote.aggregate', { roundId: round.id, counts });
}
export async function acceptActivity(
  context: GameContext,
  actorKey: string,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const { round, channel, client, timings } = context;
  if (!canAccept(context) || round?.phase !== 'OBSERVING') return effect('NO_CHANGE');
  const offset = activeElapsed(round.checkpoint.clock, atMs);
  if (offset >= timings.observationMs) return effect('NO_CHANGE');
  const bucket = Math.floor((offset * 12) / timings.observationMs);
  const inserted = await client.query(
    `insert into activity_contributions (world_id,round_id,observation_epoch,bucket,actor_key,accepted_sequence)
    values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
    [
      channel.world_id,
      round.id,
      round.checkpoint.clock.observationEpoch,
      bucket,
      actorKey,
      sequence,
    ],
  );
  return effect(inserted.rowCount === 1 ? 'APPLIED' : 'NO_CHANGE');
}
export async function acceptShock(context: GameContext): Promise<CommandEffect> {
  const { round, rules } = context;
  if (!canAccept(context) || round?.phase !== 'OBSERVING') return effect('NO_CHANGE');
  const amount = Math.min(
    rules.scoring.rawShockCap,
    round.checkpoint.shocks.reduce((sum, s) => sum + s.amount, 0) +
      categoryChangeShock(rules).amount,
  );
  await saveCheckpoint(context, {
    ...round.checkpoint,
    shocks: [{ kind: 'category_change', amount }],
  });
  return effect('APPLIED', 'habitat.changed', { shock: 'category_change' });
}
export async function applyRoundDeadline(
  context: GameContext,
  command: Extract<GameCommand, { type: 'deadline' }>,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const { round, organism, channel, client, rules, timings } = context;
  if (round === null || organism === null || round.id !== command.roundId)
    return effect('STALE_VERSION');
  if (!channel.online || !channel.healthy || gameHeld(channel) || round.checkpoint.clock.paused)
    return effect('PAUSED');
  const clock = advanceRoundClock(round.checkpoint.clock, command.revision, atMs, timings);
  if (clock === round.checkpoint.clock) return effect('STALE_VERSION');
  if (round.phase === 'VOTING') {
    const votes = await client.query<{ actor_key: string; choice: number }>(
      'select actor_key,choice from votes where world_id=$1 and round_id=$2 order by accepted_sequence',
      [channel.world_id, round.id],
    );
    const ordered: BallotVote[] = votes.rows.map((v) => ({
      actorKey: v.actor_key,
      choice: v.choice,
    }));
    if (round.checkpoint.specialBallot !== undefined)
      return closeSpecialBallot(context, ordered, sequence, atMs, clock);
    if (round.checkpoint.studioHatch !== undefined)
      return commitStudioHatch(context, clock, sequence, atMs);
    const closed = closeMutationRound(round.checkpoint, ordered, organism.mutation_slots, round.id);
    await client.query(
      // A Hold keeps the design version, so a captured studio challenge stays valid.
      'update organisms set pulse=$3,calm=$4,grit=$5,drift=$6,mutation_slots=$7,version=version+1,design_version=design_version+$8 where world_id=$1 and id=$2',
      [
        channel.world_id,
        organism.id,
        closed.genome.pulse,
        closed.genome.calm,
        closed.genome.grit,
        closed.genome.drift,
        JSON.stringify(closed.slots),
        closed.choiceId === null ? 0 : 1,
      ],
    );
    context.organism = {
      ...organism,
      ...closed.genome,
      mutation_slots: closed.slots,
      version: organism.version + 1,
      design_version: organism.design_version + (closed.choiceId === null ? 0 : 1),
    };
    await client.query('update rounds set close_sequence=$3 where world_id=$1 and id=$2', [
      channel.world_id,
      round.id,
      sequence,
    ]);
    await saveCheckpoint(context, {
      ...round.checkpoint,
      clock,
      counts: closed.tally.counts,
      ...(context.mechanics.version === 1
        ? { mutationSelection: { choiceId: closed.choiceId } }
        : {}),
    });
    await captureRoundParticipants(context);
    const dormantConsumed = await consumeDormantOffer(context, closed.choiceId, sequence);
    const dormant = await captureDormantMutation(context, closed.tally, sequence);
    return effect('APPLIED', 'ballot.closed', {
      roundId: round.id,
      choiceId: closed.choiceId,
      tally: closed.tally,
      genome: closed.genome,
      ...(dormant === null ? {} : { dormant }),
      ...(dormantConsumed === null ? {} : { dormantConsumed }),
    });
  }
  if (round.phase === 'OBSERVING') {
    await lockParticipantLineages(context);
    await captureRoundParticipants(context);
    const members = await client.query<{ actor_key: string; bucket: number }>(
      'select actor_key,bucket from activity_contributions where world_id=$1 and round_id=$2 and observation_epoch=$3 order by bucket,actor_key',
      [channel.world_id, round.id, round.checkpoint.clock.observationEpoch],
    );
    const primaryCheckpoint = await participantCheckpoint(context, organism.id, round.checkpoint);
    const finished = finishRoundObservation(
      {
        checkpoint: primaryCheckpoint,
        genome: genomeOf(organism),
        health: organism.health,
        slots: organism.mutation_slots,
        observations: members.rows.map((m) => ({
          actorKey: m.actor_key,
          offsetMs: m.bucket * rules.habitat.bucketMs,
        })),
      },
      rules,
    );
    const resolution = finished.resolution;
    if (resolution.outcome === 'interrupted')
      throw new Error('Complete interval unexpectedly interrupted.');
    const status = resolution.healthAfter === 0 ? 'FOSSIL' : organism.status;
    await client.query(
      'update organisms set health=$3,status=$4,mutation_slots=$5,version=version+1 where world_id=$1 and id=$2',
      [
        channel.world_id,
        organism.id,
        resolution.healthAfter,
        status,
        JSON.stringify(finished.slots),
      ],
    );
    context.organism = {
      ...organism,
      health: resolution.healthAfter,
      status,
      mutation_slots: finished.slots,
      version: organism.version + 1,
    };
    await client.query(
      'update rounds set confidence=$3,contributions=$4,distinct_accounts=$5,burst=$6,resolution=$7,explanation=$8 where world_id=$1 and id=$2',
      [
        channel.world_id,
        round.id,
        resolution.profile.confidence,
        resolution.profile.contributions,
        resolution.profile.distinctAccounts,
        resolution.profile.burst,
        JSON.stringify(resolution),
        JSON.stringify(finished.explanation),
      ],
    );
    if (resolution.outcome === 'applied') {
      await client.query(
        'insert into habitat_baselines (world_id,channel_id,round_id,contributions,burst,frozen,completed_at) values ($1,$2,$3,$4,$5,$6,$7)',
        [
          channel.world_id,
          channel.id,
          round.id,
          resolution.profile.contributions,
          resolution.profile.burst,
          JSON.stringify(round.checkpoint.baseline),
          new Date(atMs),
        ],
      );
      await client.query(
        'update residencies set completed_valid_rounds=completed_valid_rounds+1 where world_id=$1 and organism_id=$2 and ended_at is null',
        [channel.world_id, organism.id],
      );
    }
    if (status === 'FOSSIL')
      await client.query(
        'update residencies set ended_at=$3 where world_id=$1 and organism_id=$2 and ended_at is null',
        [channel.world_id, organism.id, new Date(atMs)],
      );
    const visitorResult = await finishVisitorObservation(
      context,
      members.rows.map((m) => ({
        actorKey: m.actor_key,
        offsetMs: m.bucket * rules.habitat.bucketMs,
      })),
      resolution,
      finished.explanation,
      primaryCheckpoint,
      sequence,
      atMs,
    );
    const dormantAged = await ageDormantMutations(context, sequence);
    const tracesAged = await ageHabitatTraces(context, resolution.outcome === 'applied', sequence);
    const tracesQualified = await qualifyHabitatTraces(context, sequence);
    const studioCancelled = await settleStudioAfterObservation(context, sequence, atMs);
    await saveCheckpoint(context, { ...round.checkpoint, clock });
    return effect(
      'APPLIED',
      visitorResult !== null
        ? 'contest.resolved'
        : status === 'FOSSIL'
          ? 'strain.fossilized'
          : 'round.resolved',
      {
        roundId: round.id,
        resolution,
        explanation: finished.explanation,
        ...(visitorResult === null ? {} : { visitor: visitorResult }),
        ...(dormantAged.length === 0 ? {} : { dormantAged }),
        ...(tracesAged.length === 0 ? {} : { tracesAged }),
        ...(tracesQualified.length === 0 ? {} : { tracesQualified }),
        ...(studioCancelled ? { studioCancelled } : {}),
      },
    );
  }
  await saveCheckpoint(context, { ...round.checkpoint, clock });
  await client.query('update rounds set completed_at=$3 where world_id=$1 and id=$2', [
    channel.world_id,
    round.id,
    new Date(atMs),
  ]);
  context.round = null;
  if (await openNextRound(context, command.nextRoundId, atMs)) {
    return effect('APPLIED', 'ballot.opened', { roundId: command.nextRoundId });
  }
  context.round = null;
  return effect('APPLIED', 'round.completed', { roundId: round.id });
}
