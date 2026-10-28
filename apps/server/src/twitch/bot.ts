import { transaction } from '@ripple/database';
import { z } from 'zod';
import type pg from 'pg';
import type { GameContext } from '../game/store.ts';
import type { CommandEffect } from '../game/lifecycle.ts';
import { TwitchClient, TwitchError } from './client.ts';

/** Called inside the game transaction; sending is always deferred until commit. */
export async function queueAnnouncement(
  context: GameContext,
  result: CommandEffect,
  sequence: number,
): Promise<void> {
  if (result.code !== 'APPLIED') return;
  const { channel, client, round, organism } = context;
  const live = await client.query("select 1 from worlds where id=$1 and mode='live'", [
    channel.world_id,
  ]);
  if (live.rowCount !== 1) return;
  let message: string | undefined;
  switch (result.updateType) {
    case 'ballot.opened':
      if (round !== null)
        message = `Ripple round ${round.number}: ${round.checkpoint.candidates.map((c, i) => `${i + 1}: ${c.effect} (${c.tradeOff})`).join('; ')}. Vote !ripple 1, 2 or 3 within ${Math.floor(context.timings.voteMs / 1000)} seconds. First valid vote stands; no votes means Hold.`;
      break;
    case 'ballot.closed': {
      const chosen = round?.checkpoint.candidates.find((c) => c.id === result.detail.choiceId);
      message =
        chosen === undefined
          ? 'Ripple: no votes; Hold. Ordinary local chat now shapes the habitat.'
          : `Ripple: ${chosen.effect}; ${chosen.tradeOff}. Ordinary local chat now shapes the habitat.`;
      break;
    }
    case 'round.resolved': {
      const explanation = z
        .object({ headline: z.string().max(250) })
        .safeParse(result.detail.explanation);
      message = explanation.success
        ? `Ripple: ${explanation.data.headline}. Energy ${organism?.health ?? 0}/100.`
        : undefined;
      break;
    }
    case 'strain.fossilized':
      message =
        'Ripple: this branch has become a fossil. Its history remains; the broadcaster can seed a new strain after the cooldown.';
      break;
    case 'paused':
      message =
        'Ripple is paused. Committed genes stay; interrupted observations do not change energy.';
      break;
    case 'resumed':
      message =
        'Ripple has resumed. Follow the current ballot; recovery starts a fresh observation when required.';
      break;
  }
  if (message === undefined) return;
  const expires = round?.checkpoint.clock.deadlineAtMs ?? Date.now() + 30000;
  await client.query(
    'insert into bot_messages(world_id,channel_id,key,message,expires_at) values($1,$2,$3,$4,$5) on conflict do nothing',
    [channel.world_id, channel.id, `event:${sequence}`, message.slice(0, 500), new Date(expires)],
  );
}
/** At most 12 sends/minute globally and 1/10s per channel, across all dispatcher processes. */
export async function dispatchBotMessage(
  pool: pg.Pool,
  api: TwitchClient,
  world: string,
): Promise<boolean> {
  const claimed = await transaction(pool, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`bot:${world}`]);
    // A process may die after Twitch accepts a message. Do not blindly resend an ambiguous attempt.
    await client.query(
      "update bot_messages set status='uncertain',error_code='SEND_OUTCOME_UNKNOWN' where world_id=$1 and status='sending' and attempt_at<clock_timestamp()-interval '30 seconds'",
      [world],
    );
    await client.query(
      "update bot_messages set status='failed',error_code='MESSAGE_EXPIRED' where world_id=$1 and status='pending' and expires_at<=clock_timestamp()",
      [world],
    );
    const rate = (
      await client.query<{ count: string }>(
        "select count(*) from bot_messages where world_id=$1 and attempt_at>clock_timestamp()-interval '1 minute'",
        [world],
      )
    ).rows[0];
    if (Number(rate?.count ?? 0) >= 12) return undefined;
    const row = (
      await client.query<{
        channel_id: string;
        key: string;
        message: string;
        twitch_id: string;
        bot_id: string;
      }>(
        `select b.channel_id,b.key,b.message,c.twitch_id,g.subject as bot_id from bot_messages b
      join channels c on c.world_id=b.world_id and c.id=b.channel_id join oauth_grants g on g.world_id=b.world_id and g.purpose='bot' and g.revoked_at is null and g.validated_at>clock_timestamp()-interval '1 hour'
      where b.world_id=$1 and b.status='pending' and c.online and c.healthy and not exists(select 1 from bot_messages recent where recent.world_id=b.world_id and recent.channel_id=b.channel_id and recent.attempt_at>clock_timestamp()-interval '10 seconds')
      order by b.created_at,b.channel_id,b.key for update of b skip locked limit 1`,
        [world],
      )
    ).rows[0];
    if (row === undefined) return undefined;
    // Superseded announcements expire rather than flooding chat after an outage.
    await client.query(
      "update bot_messages set status='sending',attempt_at=clock_timestamp() where world_id=$1 and channel_id=$2 and key=$3",
      [world, row.channel_id, row.key],
    );
    return row;
  });
  if (claimed === undefined) return false;
  try {
    const sent = z
      .object({
        data: z
          .array(
            z.object({
              is_sent: z.boolean(),
              drop_reason: z.object({ code: z.string() }).nullable().optional(),
            }),
          )
          .length(1),
      })
      .safeParse(
        await api.helix('/chat/messages', {
          method: 'POST',
          body: {
            broadcaster_id: claimed.twitch_id,
            sender_id: claimed.bot_id,
            message: claimed.message,
            for_source_only: true,
          },
        }),
      );
    if (!sent.success) throw new TwitchError(502, 'INVALID_RESPONSE');
    const row = sent.data.data[0]!;
    await pool.query(
      'update bot_messages set status=$4,error_code=$5 where world_id=$1 and channel_id=$2 and key=$3',
      [
        world,
        claimed.channel_id,
        claimed.key,
        row.is_sent ? 'sent' : 'failed',
        row.is_sent ? null : 'CHAT_MESSAGE_DROPPED',
      ],
    );
  } catch (error) {
    // Explicit rate/auth rejection was not delivered and may be retried after reconciliation/backoff.
    const retry = error instanceof TwitchError && [401, 429].includes(error.status);
    await pool.query(
      'update bot_messages set status=$4,error_code=$5 where world_id=$1 and channel_id=$2 and key=$3',
      [
        world,
        claimed.channel_id,
        claimed.key,
        retry ? 'pending' : 'uncertain',
        error instanceof TwitchError ? error.code : 'SEND_OUTCOME_UNKNOWN',
      ],
    );
  }
  return true;
}
