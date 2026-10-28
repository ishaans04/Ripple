import { randomUUID } from 'node:crypto';
import { gameCommandSchema, type GameCommand } from '@ripple/contracts';
import { ENGINE_VERSION, canonicalJson, sha256Hex } from '@ripple/engine';
import { lockChannels, transaction } from '@ripple/database';
import type pg from 'pg';
import { applyLifecycle, type CommandEffect } from './lifecycle.ts';
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

async function apply(
  context: GameContext,
  command: GameCommand,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  switch (command.type) {
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
    `update deadlines set status='cancelled',lease_owner=null,lease_until=null where world_id=$1 and channel_id=$2 and status in ('pending','leased') and ($3::text is null or job_key<>$3)`,
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
  return transaction(pool, async (client) => {
    await lockChannels(client, worldId, [channelId]);
    const activeWorld = await client.query(
      'select id from worlds where id=$1 and (expires_at is null or expires_at>clock_timestamp())',
      [worldId],
    );
    if (activeWorld.rowCount !== 1) return null;
    const context = await loadContext(client, worldId, channelId);
    const { channel } = context;
    if (channel.processed_sequence === channel.intake_sequence) return null;
    const sequence = channel.processed_sequence + 1;
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
    const command: GameCommand = intent.success
      ? intent.data.action === 'vote'
        ? {
            type: 'vote',
            actorKey: sha256Hex(
              canonicalJson([intent.data.actorBase, context.round?.id ?? 'none', 'vote']),
            ),
            choice: intent.data.choice!,
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
    const result = await apply(context, command, sequence, input.accepted_at.getTime());
    await reconcileRoundDeadline(context);
    const record = {
      engineVersion: ENGINE_VERSION,
      rulesHash: channel.rules_hash,
      sequence,
      operationId: `${input.provider}:${input.message_id}`,
      acceptedAtMs: input.accepted_at.getTime(),
      command,
      result,
      dependencies: [],
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
        '[]',
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
}
