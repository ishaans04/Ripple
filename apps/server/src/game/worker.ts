import { randomUUID } from 'node:crypto';
import { gameCommandSchema, type GameCommand } from '@ripple/contracts';
import { ENGINE_VERSION, canonicalJson, mechanicsPolicyHash, sha256Hex } from '@ripple/engine';
import { acceptInputInTransaction, lockChannels, transaction } from '@ripple/database';
import type pg from 'pg';
import { applyLifecycle, effect, type CommandEffect } from './lifecycle.ts';
import {
  acceptActivity,
  acceptShock,
  acceptVote,
  applyRoundDeadline,
  seedResident,
} from './rounds.ts';
import { loadContext, type GameContext } from './store.ts';
import { readSnapshot } from './snapshot.ts';
import { chatIntentSchema } from '../twitch/chat.ts';
import { queueAnnouncement } from '../twitch/bot.ts';
import { raidIntentSchema } from '../twitch/raid.ts';
import { forkRaid } from './raid-fork.ts';
import { admissionEligibility, applyAdmissionCommand, pendingAdmissions } from './admissions.ts';
import { openNextRound, requestPreparation } from './round-scheduling.ts';
import { operationId } from './operation-id.ts';
import { claimHistoricalRaid } from './historical-adoption.ts';
import { clearHabitatTraces, setHabitatTraces } from './trace-control.ts';

async function apply(
  context: GameContext,
  command: GameCommand,
  sequence: number,
  atMs: number,
  receiptId: string,
): Promise<CommandEffect> {
  switch (command.type) {
    case 'clearTrace':
      return clearHabitatTraces(context, sequence, atMs);
    case 'setTraces':
      return setHabitatTraces(context, command.enabled, sequence, atMs);
    case 'raid':
      return forkRaid(context, command, receiptId, sequence, atMs);
    case 'claimRaid':
      return claimHistoricalRaid(context, command, sequence, atMs);
    case 'arrive':
    case 'expireAdmission':
    case 'admission':
    case 'admissionSweep':
      return applyAdmissionCommand(context, command, sequence, atMs);
    case 'prepare':
      return requestPreparation(context);
    case 'blockLineage': {
      const lineage = await context.client.query(
        'select id from lineages where world_id=$1 and id=$2',
        [context.channel.world_id, command.lineageId],
      );
      if (lineage.rowCount !== 1) return effect('NO_CHANGE');
      const changed = command.blocked
        ? await context.client.query(
            'insert into lineage_blocks(world_id,channel_id,lineage_id) values($1,$2,$3) on conflict do nothing',
            [context.channel.world_id, context.channel.id, command.lineageId],
          )
        : await context.client.query(
            'delete from lineage_blocks where world_id=$1 and channel_id=$2 and lineage_id=$3',
            [context.channel.world_id, context.channel.id, command.lineageId],
          );
      return effect(
        changed.rowCount === 1 ? 'APPLIED' : 'NO_CHANGE',
        changed.rowCount === 1 ? 'lineage.block_changed' : null,
        { lineageId: command.lineageId, blocked: command.blocked },
      );
    }
    case 'blockSource': {
      const source = await context.client.query(
        'select id from channels where world_id=$1 and id=$2',
        [context.channel.world_id, command.sourceChannelId],
      );
      if (source.rowCount !== 1) return effect('NO_CHANGE');
      const changed = command.blocked
        ? await context.client.query(
            'insert into source_blocks(world_id,channel_id,source_channel_id) values($1,$2,$3) on conflict do nothing',
            [context.channel.world_id, context.channel.id, command.sourceChannelId],
          )
        : await context.client.query(
            'delete from source_blocks where world_id=$1 and channel_id=$2 and source_channel_id=$3',
            [context.channel.world_id, context.channel.id, command.sourceChannelId],
          );
      return effect(
        changed.rowCount === 1 ? 'APPLIED' : 'NO_CHANGE',
        changed.rowCount === 1 ? 'source.block_changed' : null,
        { sourceChannelId: command.sourceChannelId, blocked: command.blocked },
      );
    }
    case 'policy':
      await context.client.query(
        'insert into twitch_channels(world_id,channel_id,visitor_policy) values($1,$2,$3) on conflict(world_id,channel_id) do update set visitor_policy=excluded.visitor_policy',
        [context.channel.world_id, context.channel.id, command.visitorPolicy],
      );
      return effect('APPLIED', 'policy.changed', { visitorPolicy: command.visitorPolicy });
    case 'rename':
      if (context.organism?.id !== command.organismId) return effect('NO_RESIDENT');
      await context.client.query(
        'update organisms set name=$3,version=version+1 where world_id=$1 and id=$2',
        [context.channel.world_id, command.organismId, command.name],
      );
      return effect('APPLIED', 'strain.renamed', {
        organismId: command.organismId,
        name: command.name,
      });
    case 'seed':
      return seedResident(context, command, atMs);
    case 'vote':
      return acceptVote(context, command, sequence);
    case 'activity':
      return acceptActivity(context, command.actorKey, sequence, atMs);
    case 'shock':
      return acceptShock(context);
    case 'deadline':
      return applyRoundDeadline(context, command, sequence, atMs);
    case 'pause':
    case 'resume':
    case 'integration':
    case 'stream':
    case 'inputHealth':
    case 'interrupt':
    case 'recover':
      return applyLifecycle(context, command, atMs);
  }
}
/** Called with the channel lock, so a pause and its obsolete jobs commit together. */
export async function reconcileRoundDeadline(context: GameContext): Promise<void> {
  const { client, channel, round } = context;
  const clock = round?.checkpoint.clock;
  const jobKey =
    round !== null &&
    clock?.deadlineAtMs !== null &&
    clock?.deadlineAtMs !== undefined &&
    !clock.paused
      ? `${round.id}:${clock.revision}`
      : null;
  await client.query(
    `update deadlines set status='cancelled',lease_owner=null,lease_until=null where world_id=$1 and channel_id=$2 and command->>'type'='deadline' and status in ('pending','leased') and ($3::text is null or job_key<>$3)`,
    [channel.world_id, channel.id, jobKey],
  );
  if (
    jobKey === null ||
    round === null ||
    clock?.deadlineAtMs === undefined ||
    clock.deadlineAtMs === null
  )
    return;
  const command: GameCommand = {
    type: 'deadline',
    roundId: round.id,
    revision: clock.revision,
    nextRoundId: randomUUID(),
  };
  await client.query(
    `insert into deadlines (world_id,channel_id,id,job_key,command,due_at,remaining_ms) values ($1,$2,$3,$4,$5,$6,$7) on conflict (world_id,channel_id,job_key) do nothing`,
    [
      channel.world_id,
      channel.id,
      randomUUID(),
      jobKey,
      JSON.stringify(command),
      new Date(clock.deadlineAtMs),
      clock.remainingMs,
    ],
  );
}
export interface WorkerReceipt {
  sequence: number;
  effect: CommandEffect;
  checksum: string;
}
/** One accepted command, state, history and outbox either all commit or all roll back. */
export async function processNextInput(
  pool: pg.Pool,
  worldId: string,
  channelId: string,
): Promise<WorkerReceipt | null> {
  for (let contention = 0; contention < 32; contention++) {
    const outcome = await transaction<WorkerReceipt | null | 'RETRY'>(pool, async (client) => {
      const peek = (
        await client.query<{ sequence: number; command: unknown }>(
          `select i.sequence,i.command from channels c join inbox i on i.world_id=c.world_id and i.channel_id=c.id and i.sequence=c.processed_sequence+1 where c.world_id=$1 and c.id=$2`,
          [worldId, channelId],
        )
      ).rows[0];
      if (peek === undefined) return null;
      let liveRaid = raidIntentSchema.safeParse(peek.command);
      const known = gameCommandSchema.safeParse(peek.command);
      const target = liveRaid.success
        ? ((
            await client.query<{ id: string }>(
              'select id from channels where world_id=$1 and twitch_id=$2',
              [worldId, liveRaid.data.destinationTwitchId],
            )
          ).rows[0]?.id ?? null)
        : known.success && known.data.type === 'claimRaid'
          ? ((
              await client.query<{ source_channel_id: string }>(
                'select source_channel_id from transfers where world_id=$1 and id=$2',
                [worldId, known.data.transferId],
              )
            ).rows[0]?.source_channel_id ?? null)
          : known.success && known.data.type === 'raid'
            ? known.data.destinationChannelId
            : null;
      const targetExists =
        target === null
          ? false
          : (
              await client.query('select id from channels where world_id=$1 and id=$2', [
                worldId,
                target,
              ])
            ).rowCount === 1;
      const lockedTarget = targetExists ? target : null;
      await lockChannels(client, worldId, [
        channelId,
        ...(lockedTarget === null ? [] : [lockedTarget]),
      ]);
      const activeWorld = await client.query(
        'select id from worlds where id=$1 and (expires_at is null or expires_at>clock_timestamp())',
        [worldId],
      );
      if (activeWorld.rowCount !== 1) return null;
      const context = await loadContext(client, worldId, channelId);
      const { channel } = context;
      if (channel.processed_sequence === channel.intake_sequence) return null;
      const sequence = channel.processed_sequence + 1;
      if (sequence !== peek.sequence) {
        const next = (
          await client.query<{ command: unknown }>(
            'select command from inbox where world_id=$1 and channel_id=$2 and sequence=$3',
            [worldId, channelId, sequence],
          )
        ).rows[0];
        if (next === undefined) throw new Error('The next accepted sequence is missing');
        liveRaid = raidIntentSchema.safeParse(next.command);
        const current = gameCommandSchema.safeParse(next.command);
        // Ordinary commands still need only this channel lock. A new raid needs a fresh sorted lock set.
        if (
          liveRaid.success ||
          (current.success && ['raid', 'claimRaid'].includes(current.data.type))
        )
          return 'RETRY';
      }
      if (liveRaid.success) {
        const actual =
          (
            await client.query<{ id: string }>(
              'select id from channels where world_id=$1 and twitch_id=$2',
              [worldId, liveRaid.data.destinationTwitchId],
            )
          ).rows[0]?.id ?? null;
        if (actual !== lockedTarget) return 'RETRY';
      }
      const input = (
        await client.query<{
          command: unknown;
          accepted_at: Date;
          provider: string;
          message_id: string;
        }>(
          'select command,accepted_at,provider,message_id from inbox where world_id=$1 and channel_id=$2 and sequence=$3',
          [worldId, channelId, sequence],
        )
      ).rows[0];
      if (input === undefined) throw new Error('The next accepted sequence is missing.');
      const intent = chatIntentSchema.safeParse(input.command);
      let command: GameCommand = liveRaid.success
        ? {
            ...liveRaid.data,
            type: 'raid',
            destinationChannelId: lockedTarget,
            retainUnenrolled: true,
          }
        : intent.success
          ? intent.data.action === 'vote'
            ? {
                type: 'vote',
                actorKey: sha256Hex(
                  canonicalJson([intent.data.actorBase, context.round?.id ?? 'none', 'vote']),
                ),
                choice: intent.data.choice,
              }
            : {
                type: 'activity',
                actorKey: sha256Hex(
                  canonicalJson([
                    intent.data.actorBase,
                    context.round?.id ?? 'none',
                    context.round?.checkpoint.clock.observationEpoch ?? 0,
                    'activity',
                  ]),
                ),
              }
          : gameCommandSchema.parse(input.command);
      if (command.type === 'raid') command = { ...command, destinationChannelId: lockedTarget };
      const mode = (
        await client.query<{ mode: string }>('select mode from worlds where id=$1', [worldId])
      ).rows[0]?.mode;
      if (command.type === 'raid')
        command = {
          ...command,
          sourceAuthorized:
            mode !== 'live' && command.sourceAuthorized !== undefined
              ? command.sourceAuthorized
              : (await admissionEligibility(context)).authorized,
        };
      if (
        command.type === 'arrive' ||
        command.type === 'admission' ||
        command.type === 'admissionSweep' ||
        command.type === 'claimRaid'
      )
        command = {
          ...command,
          eligibility:
            mode !== 'live' && command.eligibility !== undefined
              ? command.eligibility
              : await admissionEligibility(context),
        };
      if (command.type === 'claimRaid' && mode !== 'replay') {
        const identity = (
          await client.query<{ claimant: string; checked_at: Date }>(
            `select coalesce(c.twitch_id,c.id::text) as claimant,
          coalesce(w.clock_at,date_trunc('milliseconds',clock_timestamp())) as checked_at
          from channels c join worlds w on w.id=c.world_id where c.world_id=$1 and c.id=$2`,
            [worldId, channelId],
          )
        ).rows[0];
        if (identity === undefined) throw new Error('Missing historical claimant channel.');
        command = {
          ...command,
          claimantTwitchId: identity.claimant,
          checkedAtMs: identity.checked_at.getTime(),
        };
      }
      let result =
        'expectedVersion' in command &&
        command.expectedVersion !== undefined &&
        command.expectedVersion !== channel.state_version
          ? effect('STALE_VERSION')
          : await apply(
              context,
              command,
              sequence,
              input.accepted_at.getTime(),
              `${input.provider}:${input.message_id}`,
            );
      let opened = false;
      if (
        result.code === 'APPLIED' &&
        context.round === null &&
        context.channel.online &&
        context.channel.healthy &&
        !context.channel.paused
      ) {
        const openingId =
          'roundId' in command && command.roundId !== undefined
            ? command.roundId
            : operationId(channelId, sequence, 'round');
        opened = await openNextRound(context, openingId, input.accepted_at.getTime());
        if (opened) result = { ...result, detail: { ...result.detail, openedRoundId: openingId } };
      }
      const wakesAdmission =
        [
          'policy',
          'blockSource',
          'blockLineage',
          'stream',
          'inputHealth',
          'integration',
          'resume',
          'recover',
          'admission',
          'expireAdmission',
        ].includes(command.type) ||
        (command.type === 'deadline' &&
          ['contest.resolved', 'strain.fossilized', 'ballot.closed'].includes(
            result.updateType ?? '',
          )) ||
        (command.type === 'arrive' && result.detail.archived === true);
      if (
        result.code === 'APPLIED' &&
        wakesAdmission &&
        mode !== 'replay' &&
        (['policy', 'blockSource', 'blockLineage'].includes(command.type) ||
          (channel.online &&
            channel.healthy &&
            !channel.paused &&
            context.round?.phase !== 'INTERRUPTED')) &&
        (await pendingAdmissions(context)).length > 0
      )
        await acceptInputInTransaction(client, {
          worldId,
          channelId,
          provider: 'admission-wakeup',
          messageId: `${channelId}:${sequence}`,
          command: {
            type: 'admissionSweep',
            roundId: operationId(channelId, sequence, 'admissions'),
          },
          ...(mode === 'live' ? {} : { acceptedAtMs: input.accepted_at.getTime() }),
        });
      await reconcileRoundDeadline(context);
      await queueAnnouncement(
        context,
        opened ? effect('APPLIED', 'ballot.opened') : result,
        sequence,
      );
      if (context.mechanics.version === 1)
        result = {
          ...result,
          detail: {
            ...result.detail,
            mechanics: { version: 1, policyHash: mechanicsPolicyHash(context.mechanics.policy) },
          },
        };
      const record = {
        engineVersion: ENGINE_VERSION,
        rulesHash: channel.rules_hash,
        sequence,
        operationId: `${input.provider}:${input.message_id}`,
        acceptedAtMs: input.accepted_at.getTime(),
        command,
        result,
        dependencies: result.dependencies ?? [],
      };
      const checksum = sha256Hex(canonicalJson({ previousChecksum: channel.checksum, ...record }));
      await client.query(
        `insert into game_events (world_id,channel_id,sequence,id,operation_id,engine_version,rules_hash,accepted_at,command,result,dependencies,previous_checksum,checksum)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          worldId,
          channelId,
          sequence,
          randomUUID(),
          record.operationId,
          ENGINE_VERSION,
          channel.rules_hash,
          input.accepted_at,
          JSON.stringify(command),
          JSON.stringify(result),
          JSON.stringify(record.dependencies),
          channel.checksum,
          checksum,
        ],
      );
      const version = channel.state_version + (result.updateType === null ? 0 : 1);
      await client.query(
        'update channels set processed_sequence=$3,state_version=$4,checksum=$5 where world_id=$1 and id=$2',
        [worldId, channelId, sequence, version, checksum],
      );
      await client.query(
        'update inbox set processed_at=clock_timestamp(),attempts=attempts+1,error_code=null where world_id=$1 and channel_id=$2 and sequence=$3',
        [worldId, channelId, sequence],
      );
      if (result.updateType !== null) {
        const snapshot = await readSnapshot(client, worldId, channelId);
        if (snapshot === null) throw new Error('Cannot publish an expired world.');
        await client.query(
          'insert into public_updates (world_id,channel_id,version,event_id,type,payload) values ($1,$2,$3,$4,$5,$6)',
          [
            worldId,
            channelId,
            version,
            randomUUID(),
            result.updateType,
            JSON.stringify(snapshot.payload),
          ],
        );
      }
      return { sequence, effect: result, checksum };
    });
    if (outcome !== 'RETRY') return outcome;
  }
  return null;
}
