import { transaction, acceptInputInTransaction } from '@ripple/database';
import { canonicalJson, sha256Hex } from '@ripple/engine';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { type TwitchClient, TwitchError } from './client.ts';
import { subscriptionVersions } from './webhook.ts';

const remoteSchema = z.object({
  id: z.string(),
  type: z.string(),
  version: z.string(),
  status: z.string(),
  condition: z.record(z.string(), z.string()),
  cost: z.int().nonnegative(),
  transport: z.object({ method: z.string(), callback: z.string().optional() }),
});
const pageSchema = z.object({
  data: z.array(remoteSchema),
  total_cost: z.int().nonnegative(),
  max_total_cost: z.int().nonnegative(),
  pagination: z.object({ cursor: z.string().optional() }).optional(),
});
type Remote = z.infer<typeof remoteSchema>;
export async function listSubscriptions(
  api: TwitchClient,
): Promise<{ subscriptions: Remote[]; totalCost: number; maxCost: number }> {
  const subscriptions: Remote[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = pageSchema.safeParse(
      await api.helix(
        `/eventsub/subscriptions${cursor === undefined ? '' : `?after=${encodeURIComponent(cursor)}`}`,
      ),
    );
    if (!result.success) throw new TwitchError(502, 'INVALID_RESPONSE');
    subscriptions.push(...result.data.data);
    const totalCost = result.data.total_cost,
      maxCost = result.data.max_total_cost;
    cursor = result.data.pagination?.cursor;
    if (cursor === undefined) return { subscriptions, totalCost, maxCost };
  }
  throw new TwitchError(502, 'INVALID_RESPONSE');
}
async function markHealth(
  client: pg.PoolClient,
  world: string,
  channel: string,
  healthy: boolean,
  error: string | null,
): Promise<void> {
  const changed = await client.query(
    'update twitch_channels set input_error=$3 where world_id=$1 and channel_id=$2 and input_error is distinct from $3 returning channel_id',
    [world, channel, error],
  );
  const state = (
    await client.query<{ healthy: boolean }>(
      'select healthy from channels where world_id=$1 and id=$2',
      [world, channel],
    )
  ).rows[0];
  if (changed.rowCount === 1 || state?.healthy !== healthy)
    await acceptInputInTransaction(client, {
      worldId: world,
      channelId: channel,
      provider: 'twitch-health',
      messageId: randomUUID(),
      command: { type: 'inputHealth', healthy },
      requiredMode: 'live',
    });
}
/** External calls run outside channel transactions; per-row attempts fence duplicate creation. */
export async function reconcileSubscriptions(
  pool: pg.Pool,
  api: TwitchClient,
  world: string,
): Promise<{ totalCost: number; maxCost: number }> {
  const listedAt = new Date();
  const listing = await listSubscriptions(api);
  const bot = (
    await pool.query<{ subject: string }>(
      "select subject from oauth_grants where world_id=$1 and purpose='bot' and revoked_at is null and expires_at>clock_timestamp() and validated_at>clock_timestamp()-interval '1 hour'",
      [world],
    )
  ).rows[0];
  const channels = await pool.query<{ id: string; twitch_id: string; authorized: boolean }>(
    `select c.id,c.twitch_id,exists(select 1 from oauth_grants g where g.world_id=c.world_id and g.channel_id=c.id and g.purpose='broadcaster' and g.revoked_at is null and g.expires_at>clock_timestamp() and g.validated_at>clock_timestamp()-interval '1 hour') as authorized from channels c join twitch_channels t on t.world_id=c.world_id and t.channel_id=c.id where c.world_id=$1 order by c.id`,
    [world],
  );
  const callback = `${api.config.origin}/webhooks/twitch`,
    transportHash = sha256Hex(canonicalJson([callback, api.config.webhookSecret]));
  for (const channel of channels.rows) {
    if (bot === undefined || !channel.authorized) {
      await transaction(pool, async (client) => {
        await client.query('select id from channels where world_id=$1 and id=$2 for update', [
          world,
          channel.id,
        ]);
        await markHealth(
          client,
          world,
          channel.id,
          false,
          bot === undefined ? 'BOT_AUTHORIZATION_REQUIRED' : 'BROADCASTER_AUTHORIZATION_REQUIRED',
        );
      });
      continue;
    }
    for (const [type, version] of Object.entries(subscriptionVersions)) {
      const condition: Record<string, string> =
        type === 'channel.chat.message'
          ? { broadcaster_user_id: channel.twitch_id, user_id: bot.subject }
          : { broadcaster_user_id: channel.twitch_id };
      let obsolete: string | undefined;
      let attemptAt: Date | undefined;
      const claimed = await transaction(pool, async (client) => {
        await client.query('select id from channels where world_id=$1 and id=$2 for update', [
          world,
          channel.id,
        ]);
        const stored = (
          await client.query<{
            provider_id: string | null;
            transport_hash: string;
            condition: unknown;
            status: string;
            recent: boolean;
            verified_at: Date | null;
          }>(
            "select *,attempt_at>clock_timestamp()-interval '90 seconds' as recent from twitch_subscriptions where world_id=$1 and channel_id=$2 and type=$3",
            [world, channel.id, type],
          )
        ).rows[0];
        const same =
          stored?.transport_hash === transportHash &&
          canonicalJson(stored.condition) === canonicalJson(condition);
        const remote = same
          ? listing.subscriptions.find(
              (r) =>
                (r.id === stored.provider_id || stored.provider_id === null) &&
                r.type === type &&
                r.version === version &&
                r.transport.callback === callback &&
                canonicalJson(r.condition) === canonicalJson(condition),
            )
          : undefined;
        if (
          remote?.status === 'enabled' &&
          stored?.status === 'enabled' &&
          stored.verified_at !== null
        ) {
          await client.query(
            "update twitch_subscriptions set status='enabled',cost=$4 where world_id=$1 and channel_id=$2 and type=$3",
            [world, channel.id, type, remote.cost],
          );
          return false;
        }
        // A challenge received after this REST request began is fresher evidence than its listing.
        if (
          same &&
          stored.status === 'enabled' &&
          stored.verified_at !== null &&
          stored.verified_at.getTime() >= listedAt.getTime()
        )
          return false;
        if (same && stored.status === 'enabled' && remote?.status !== 'enabled') {
          await client.query(
            'update twitch_subscriptions set status=$4 where world_id=$1 and channel_id=$2 and type=$3',
            [world, channel.id, type, remote?.status ?? 'SUBSCRIPTION_MISSING'],
          );
          await markHealth(client, world, channel.id, false, 'SUBSCRIPTIONS_PENDING');
        }
        if (same && stored.recent) return false;
        obsolete = remote?.id ?? stored?.provider_id ?? undefined;
        const claimedRow = await client.query<{ attempt_at: Date }>(
          `insert into twitch_subscriptions(world_id,channel_id,type,version,condition,status,transport_hash,attempt_at) values($1,$2,$3,$4,$5,'creating',$6,date_trunc('milliseconds',clock_timestamp()))
          on conflict(world_id,channel_id,type) do update set provider_id=null,version=excluded.version,condition=excluded.condition,status='creating',transport_hash=excluded.transport_hash,attempt_at=excluded.attempt_at,verified_at=null returning attempt_at`,
          [world, channel.id, type, version, JSON.stringify(condition), transportHash],
        );
        const attempt = claimedRow.rows[0];
        if (attempt === undefined) throw new Error('Subscription attempt missing');
        attemptAt = attempt.attempt_at;
        await markHealth(client, world, channel.id, false, 'SUBSCRIPTIONS_PENDING');
        return true;
      });
      if (!claimed) continue;
      try {
        if (obsolete !== undefined) {
          try {
            await api.helix(`/eventsub/subscriptions?id=${encodeURIComponent(obsolete)}`, {
              method: 'DELETE',
            });
          } catch (error) {
            if (!(error instanceof TwitchError) || error.status !== 404) throw error;
          }
        }
        const response = z
          .object({
            data: z.array(remoteSchema).min(1),
            total_cost: z.int().nonnegative(),
            max_total_cost: z.int().nonnegative(),
          })
          .safeParse(
            await api.helix('/eventsub/subscriptions', {
              method: 'POST',
              body: {
                type,
                version,
                condition,
                transport: { method: 'webhook', callback, secret: api.config.webhookSecret },
              },
            }),
          );
        if (!response.success) throw new TwitchError(502, 'INVALID_RESPONSE');
        const created = response.data.data[0];
        if (created === undefined) throw new TwitchError(502, 'INVALID_RESPONSE');
        // A verified callback may already have enabled this row; never downgrade it.
        await pool.query(
          `update twitch_subscriptions set provider_id=$4,cost=$5,status=case when verified_at is not null then status else $6 end where world_id=$1 and channel_id=$2 and type=$3 and transport_hash=$7 and attempt_at=$8 and (provider_id is null or provider_id=$4)`,
          [
            world,
            channel.id,
            type,
            created.id,
            created.cost,
            created.status,
            transportHash,
            attemptAt,
          ],
        );
      } catch (error) {
        const code =
          error instanceof TwitchError
            ? error.status === 409
              ? 'SUBSCRIPTION_CONFLICT'
              : error.code
            : 'PROVIDER_UNAVAILABLE';
        await pool.query(
          "update twitch_subscriptions set status=$4 where world_id=$1 and channel_id=$2 and type=$3 and status='creating' and attempt_at=$5",
          [world, channel.id, type, code, attemptAt],
        );
      }
    }
    await transaction(pool, async (client) => {
      await client.query('select id from channels where world_id=$1 and id=$2 for update', [
        world,
        channel.id,
      ]);
      const ready =
        (
          await client.query<{ ready: boolean }>(
            "select count(*)=4 and bool_and(status='enabled' and verified_at is not null and transport_hash=$3) as ready from twitch_subscriptions where world_id=$1 and channel_id=$2",
            [world, channel.id, transportHash],
          )
        ).rows[0]?.ready === true;
      await markHealth(client, world, channel.id, ready, ready ? null : 'SUBSCRIPTIONS_PENDING');
    });
  }
  return { totalCost: listing.totalCost, maxCost: listing.maxCost };
}
