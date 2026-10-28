import { randomUUID } from 'node:crypto';
import { acceptInputInTransaction } from '@ripple/database';
import {
  forkBlock,
  inheritCommittedDesign,
  initialMutationSlots,
  prepareArrival,
  preparationSchema,
  raidPolicyHash,
} from '@ripple/engine';
import type { PropagationCommand } from '@ripple/contracts';
import { effect, type CommandEffect } from './lifecycle.ts';
import { genomeOf, type GameContext, type OrganismRow } from './store.ts';
import { loadRaidPolicy, type TransferRow, type TransferSnapshot } from './propagation-store.ts';

interface Parent extends OrganismRow {
  name: string;
  lineage_id: string;
  founder_id: string;
  generation: number;
  origin_channel_id: string;
}
/** Caller holds source/destination channel locks in sorted order. No external calls occur here. */
export async function forkRaid(
  context: GameContext,
  command: Extract<PropagationCommand, { type: 'raid' }>,
  receiptId: string,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const { client, channel, rules } = context;
  const existing = (
    await client.query<TransferRow>('select * from transfers where world_id=$1 and receipt_id=$2', [
      channel.world_id,
      receiptId,
    ])
  ).rows[0];
  if (existing !== undefined)
    return effect('NO_CHANGE', null, {
      transferId: existing.id,
      outcome: existing.outcome,
      duplicate: true,
    });
  const policy = await loadRaidPolicy(client, channel.world_id);
  const parent = (
    await client.query<Parent>(
      `select o.*,l.origin_channel_id from organisms o join residencies r on r.world_id=o.world_id and r.organism_id=o.id join lineages l on l.world_id=o.world_id and l.id=o.lineage_id where r.world_id=$1 and r.channel_id=$2 and r.role='resident' and r.ended_at is null and o.status='ALIVE' order by o.health desc,o.id limit 1`,
      [channel.world_id, channel.id],
    )
  ).rows[0];
  if (parent !== undefined)
    await client.query('select id from lineages where world_id=$1 and id=$2 for update', [
      channel.world_id,
      parent.lineage_id,
    ]);
  const livingBranchIds =
    parent === undefined
      ? []
      : (
          await client.query<{ id: string }>(
            "select id from organisms where world_id=$1 and lineage_id=$2 and status in ('ALIVE','HARBOR') order by id",
            [channel.world_id, parent.lineage_id],
          )
        ).rows.map((row) => row.id);
  const budget = livingBranchIds.length;
  const last =
    parent === undefined
      ? null
      : ((
          await client.query<{ created_at: Date }>(
            `select t.created_at from transfers t join organisms o on o.world_id=t.world_id and o.id=t.parent_id where t.world_id=$1 and t.source_channel_id=$2 and t.destination_twitch_id=$3 and t.child_id is not null and o.lineage_id=$4 order by t.created_at desc limit 1`,
            [channel.world_id, channel.id, command.destinationTwitchId, parent.lineage_id],
          )
        ).rows[0]?.created_at.getTime() ?? null);
  const preparation = preparationSchema.parse(
    (
      await client.query<{ preparation: string }>(
        'select preparation from channel_play where world_id=$1 and channel_id=$2',
        [channel.world_id, channel.id],
      )
    ).rows[0]?.preparation ?? 'neutral',
  );
  const destination =
    command.destinationChannelId === null
      ? undefined
      : (
          await client.query<{
            id: string;
            state_version: number;
            processed_sequence: number;
            intake_sequence: number;
          }>(
            'select id,state_version,processed_sequence,intake_sequence from channels where world_id=$1 and id=$2',
            [channel.world_id, command.destinationChannelId],
          )
        ).rows[0];
  const queued =
    destination === undefined
      ? []
      : (
          await client.query<{ id: string }>(
            `select id from transfers where world_id=$1 and destination_channel_id=$2 and child_id is not null and outcome in ('QUEUED','PENDING_APPROVAL','OFFLINE_HOLD','GRANT_REVOKED','INPUT_UNAVAILABLE','RULES_INCOMPATIBLE','HARBOR') order by created_at,id`,
            [channel.world_id, destination.id],
          )
        ).rows.map((row) => row.id);
  const block = forkBlock(
    {
      sourceEligible: parent !== undefined,
      sameChannel: destination?.id === channel.id,
      livingBranches: budget,
      parentGeneration: parent?.generation ?? 0,
      lastPairForkAtMs: last,
      atMs,
    },
    policy,
  );
  const outcome =
    (parent !== undefined && command.sourceAuthorized === false
      ? 'SOURCE_AUTHORIZATION_REVOKED'
      : block) ??
    (destination === undefined
      ? 'NOT_ENROLLED'
      : queued.length >= policy.harborCap
        ? 'HARBOR_FULL'
        : 'QUEUED');
  const inherited =
    parent === undefined
      ? null
      : inheritCommittedDesign({ genome: genomeOf(parent), appearance: parent.appearance });
  const arrival =
    parent === undefined
      ? null
      : prepareArrival(parent.health, genomeOf(parent), preparation, rules, policy);
  const snapshot: TransferSnapshot = {
    schemaVersion: 1,
    residencyId: command.residencyId,
    arrivalRoundId: command.arrivalRoundId,
    policy,
    policyHash: raidPolicyHash(policy),
    sourceRulesHash: channel.rules_hash,
    sourceChannelId: channel.id,
    sourceSequence: sequence,
    sourceVersion: channel.state_version,
    preparation,
    arrival,
    queuedAhead: queued,
    livingBranchIds,
    parent:
      parent === undefined || inherited === null
        ? null
        : {
            id: parent.id,
            version: parent.version,
            lineageId: parent.lineage_id,
            founderId: parent.founder_id,
            generation: parent.generation,
            name: parent.name,
            genome: inherited.genome,
            health: parent.health,
            appearance: inherited.appearance,
            originChannelId: parent.origin_channel_id,
          },
  };
  const childId = outcome === 'QUEUED' ? command.childId : null;
  if (childId !== null && parent !== undefined && inherited !== null && arrival !== null) {
    const g = inherited.genome;
    await client.query(
      `insert into organisms(world_id,id,lineage_id,parent_id,founder_id,generation,founding_genome,pulse,calm,grit,drift,health,status,appearance,mutation_slots,name,created_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'HARBOR',$13,$14,$15,$16)`,
      [
        channel.world_id,
        childId,
        parent.lineage_id,
        parent.id,
        parent.founder_id,
        parent.generation + 1,
        JSON.stringify(g),
        g.pulse,
        g.calm,
        g.grit,
        g.drift,
        arrival.health,
        JSON.stringify(inherited.appearance),
        JSON.stringify(initialMutationSlots),
        parent.name,
        new Date(atMs),
      ],
    );
  }
  await client.query(
    `insert into transfers(world_id,id,receipt_id,source_channel_id,destination_channel_id,destination_twitch_id,source_version,parent_id,child_id,outcome,snapshot,expires_at,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      channel.world_id,
      command.transferId,
      receiptId,
      channel.id,
      destination?.id ?? null,
      command.destinationTwitchId,
      channel.state_version,
      parent?.id ?? null,
      childId,
      outcome,
      JSON.stringify(snapshot),
      new Date(atMs + policy.admissionTtlMs),
      new Date(atMs),
    ],
  );
  await client.query(
    'insert into transfer_transitions(world_id,transfer_id,version,outcome,at,channel_id,sequence,detail) values($1,$2,0,$3,$4,$5,$6,$7)',
    [
      channel.world_id,
      command.transferId,
      outcome,
      new Date(atMs),
      channel.id,
      sequence,
      JSON.stringify({ childId, sourceVersion: channel.state_version }),
    ],
  );
  let destinationReceipt: { sequence: number; acceptedAtMs: number } | null = null;
  if (childId !== null && destination !== undefined) {
    const mode = (
      await client.query<{ mode: string }>('select mode from worlds where id=$1', [
        channel.world_id,
      ])
    ).rows[0]?.mode;
    destinationReceipt = await acceptInputInTransaction(client, {
      worldId: channel.world_id,
      channelId: destination.id,
      provider: 'raid-arrival',
      messageId: command.transferId,
      command: { type: 'arrive', transferId: command.transferId, roundId: command.arrivalRoundId },
      ...(mode === 'live' ? {} : { acceptedAtMs: atMs }),
    });
    await client.query('update transfers set destination_sequence=$3 where world_id=$1 and id=$2', [
      channel.world_id,
      command.transferId,
      destinationReceipt.sequence,
    ]);
    await client.query(
      `insert into deadlines(world_id,channel_id,id,job_key,command,due_at,remaining_ms) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
      [
        channel.world_id,
        destination.id,
        randomUUID(),
        `admission-expiry:${command.transferId}`,
        JSON.stringify({ type: 'expireAdmission', transferId: command.transferId }),
        new Date(atMs + policy.admissionTtlMs),
        policy.admissionTtlMs,
      ],
    );
  }
  return {
    ...effect('APPLIED', 'raid.recorded', {
      transferId: command.transferId,
      outcome,
      childId,
      snapshot,
      destinationReceipt,
    }),
    dependencies:
      destination === undefined
        ? []
        : [
            {
              channelId: destination.id,
              stateVersion: destination.state_version,
              processedSequence: destination.processed_sequence,
              intakeSequence: destination.intake_sequence,
              arrivalSequence: destinationReceipt?.sequence ?? null,
              queuedAhead: queued,
            },
          ],
  };
}
