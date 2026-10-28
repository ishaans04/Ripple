import { randomUUID } from 'node:crypto';
import { transaction, acceptInputInTransaction } from '@ripple/database';
import { z } from 'zod';
import type pg from 'pg';
import { type TwitchClient, TwitchError } from './client.ts';

/** Reconcile missed lifecycle notifications without overwriting a newer webhook. */
export async function reconcileStreams(
  pool: pg.Pool,
  api: TwitchClient,
  worldId: string,
): Promise<void> {
  const channels = await pool.query<{
    id: string;
    twitch_id: string;
    lifecycle_at: Date | null;
    category_at: Date | null;
  }>(
    `select c.id,c.twitch_id,t.lifecycle_at,t.category_at from channels c join twitch_channels t on t.world_id=c.world_id and t.channel_id=c.id where c.world_id=$1 order by c.id`,
    [worldId],
  );
  for (const channel of channels.rows) {
    const startedAt = new Date();
    const stream = z
      .object({ data: z.array(z.object({ user_id: z.string(), type: z.string() })) })
      .safeParse(await api.helix(`/streams?user_id=${encodeURIComponent(channel.twitch_id)}`));
    const info = z
      .object({
        data: z
          .array(z.object({ broadcaster_id: z.string(), game_id: z.string().max(100) }))
          .length(1),
      })
      .safeParse(
        await api.helix(`/channels?broadcaster_id=${encodeURIComponent(channel.twitch_id)}`),
      );
    if (
      !stream.success ||
      !info.success ||
      info.data.data[0]?.broadcaster_id !== channel.twitch_id ||
      stream.data.data.some((s) => s.user_id !== channel.twitch_id)
    )
      throw new TwitchError(502, 'INVALID_RESPONSE');
    const infoEntry = info.data.data[0];
    await transaction(pool, async (client) => {
      await client.query('select id from channels where world_id=$1 and id=$2 for update', [
        worldId,
        channel.id,
      ]);
      const current = (
        await client.query<{ category_id: string | null }>(
          'select category_id from twitch_channels where world_id=$1 and channel_id=$2',
          [worldId, channel.id],
        )
      ).rows[0];
      const scope = {
        worldId,
        channelId: channel.id,
        provider: 'twitch-reconcile',
        requiredMode: 'live' as const,
      };
      const lifecycle = await client.query(
        'update twitch_channels set lifecycle_at=$4 where world_id=$1 and channel_id=$2 and lifecycle_at is not distinct from $3',
        [worldId, channel.id, channel.lifecycle_at, startedAt],
      );
      if (lifecycle.rowCount === 1)
        await acceptInputInTransaction(client, {
          ...scope,
          messageId: randomUUID(),
          command: { type: 'stream', online: stream.data.data.some((s) => s.type === 'live') },
        });
      const category = infoEntry.game_id;
      const updated = await client.query(
        'update twitch_channels set category_id=$4,category_at=$5 where world_id=$1 and channel_id=$2 and category_at is not distinct from $3',
        [worldId, channel.id, channel.category_at, category, startedAt],
      );
      if (
        updated.rowCount === 1 &&
        current?.category_id !== undefined &&
        current.category_id !== null &&
        current.category_id !== category
      )
        await acceptInputInTransaction(client, {
          ...scope,
          messageId: randomUUID(),
          command: { type: 'shock', kind: 'category_change' },
        });
    });
  }
}
