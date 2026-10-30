import { randomUUID } from 'node:crypto';
import { lockChannels, transaction } from '@ripple/database';
import { ENGINE_VERSION, canonicalJson, mechanicsPolicyHash, sha256Hex } from '@ripple/engine';
import { gameCommandSchema } from '@ripple/contracts';
import type pg from 'pg';
import { chatIntentSchema } from '../twitch/chat.ts';
import { loadContext } from './store.ts';
import { acceptActivity } from './rounds.ts';
import type { WorkerReceipt } from './worker.ts';

function activity(value: unknown) {
  if (typeof value !== 'object' || value === null || !('type' in value)) return null;
  if (value.type === 'twitch.chat') {
    const parsed = chatIntentSchema.safeParse(value);
    return parsed.success && parsed.data.action === 'activity' ? parsed.data : null;
  }
  if (value.type === 'activity') {
    const parsed = gameCommandSchema.safeParse(value);
    return parsed.success && parsed.data.type === 'activity' ? parsed.data : null;
  }
  return null;
}
/** Batch only consecutive ordinary activity. A vote, cutoff, raid or control is always a barrier. */
export async function processActivityBatch(
  pool: pg.Pool,
  worldId: string,
  channelId: string,
  limit = 4,
): Promise<WorkerReceipt[] | null> {
  const peek = (
    await pool.query<{ command: unknown }>(
      `select i.command from channels c join inbox i on i.world_id=c.world_id and i.channel_id=c.id and i.sequence=c.processed_sequence+1 where c.world_id=$1 and c.id=$2`,
      [worldId, channelId],
    )
  ).rows[0];
  if (!peek || activity(peek.command) === null) return null;
  return transaction(pool, async (client) => {
    await lockChannels(client, worldId, [channelId]);
    if (
      (
        await client.query(
          'select id from worlds where id=$1 and (expires_at is null or expires_at>clock_timestamp())',
          [worldId],
        )
      ).rowCount !== 1
    )
      return [];
    const context = await loadContext(client, worldId, channelId),
      channel = context.channel;
    const inputs = (
      await client.query<{
        sequence: number;
        command: unknown;
        accepted_at: Date;
        provider: string;
        message_id: string;
      }>(
        'select sequence,command,accepted_at,provider,message_id from inbox where world_id=$1 and channel_id=$2 and sequence>$3 order by sequence limit $4',
        [worldId, channelId, channel.processed_sequence, Math.max(1, Math.min(4, limit))],
      )
    ).rows;
    const receipts: WorkerReceipt[] = [],
      records: Record<string, unknown>[] = [];
    let checksum = channel.checksum;
    for (const input of inputs) {
      const normalized = activity(input.command);
      if (normalized === null) break;
      const command = {
        type: 'activity' as const,
        actorKey:
          normalized.type === 'twitch.chat'
            ? sha256Hex(
                canonicalJson([
                  normalized.actorBase,
                  context.round?.id ?? 'none',
                  context.round?.checkpoint.clock.observationEpoch ?? 0,
                  'activity',
                ]),
              )
            : normalized.actorKey,
      };
      let result = await acceptActivity(
        context,
        command.actorKey,
        input.sequence,
        input.accepted_at.getTime(),
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
        sequence: input.sequence,
        operationId: `${input.provider}:${input.message_id}`,
        acceptedAtMs: input.accepted_at.getTime(),
        command,
        result,
        dependencies: [],
      };
      const previous = checksum;
      checksum = sha256Hex(canonicalJson({ previousChecksum: previous, ...record }));
      records.push({
        world_id: worldId,
        channel_id: channelId,
        sequence: input.sequence,
        id: randomUUID(),
        operation_id: record.operationId,
        engine_version: ENGINE_VERSION,
        rules_hash: channel.rules_hash,
        accepted_at: input.accepted_at.toISOString(),
        command,
        result,
        dependencies: [],
        previous_checksum: previous,
        checksum,
      });
      receipts.push({ sequence: input.sequence, effect: result, checksum });
    }
    if (!receipts.length) return null;
    await client.query(
      `insert into game_events(world_id,channel_id,sequence,id,operation_id,engine_version,rules_hash,accepted_at,command,result,dependencies,previous_checksum,checksum)
      select * from jsonb_to_recordset($1::jsonb) r(world_id uuid,channel_id uuid,sequence int,id uuid,operation_id text,engine_version int,rules_hash text,accepted_at timestamptz,command jsonb,result jsonb,dependencies jsonb,previous_checksum text,checksum text)`,
      [JSON.stringify(records)],
    );
    const last = receipts.at(-1);
    if (!last) throw new Error('Missing activity batch receipt');
    await client.query(
      'update channels set processed_sequence=$3,checksum=$4 where world_id=$1 and id=$2',
      [worldId, channelId, last.sequence, checksum],
    );
    await client.query(
      'update inbox set processed_at=clock_timestamp(),attempts=attempts+1,error_code=null where world_id=$1 and channel_id=$2 and sequence>$3 and sequence<=$4',
      [worldId, channelId, channel.processed_sequence, last.sequence],
    );
    return receipts;
  });
}
