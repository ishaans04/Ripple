import { acceptInputInTransaction, transaction } from '@ripple/database';
import { sha256Hex } from '@ripple/engine';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { normalizeChat } from './chat.ts';
import type { TwitchConfig } from './security.ts';
import { ControlError } from './sessions.ts';
import { verifyWebhook } from './signature.ts';
import { errorBody } from '../errors.ts';

export const subscriptionVersions: Readonly<Record<string, string>> = Object.freeze({
  'channel.chat.message': '1',
  'stream.online': '1',
  'stream.offline': '1',
  'channel.update': '2',
});
const bodySchema = z.object({
  subscription: z.object({
    id: z.string().min(1).max(200),
    type: z.string(),
    version: z.string(),
    status: z.string(),
    condition: z.record(z.string(), z.string()),
    transport: z.object({ method: z.literal('webhook'), callback: z.string() }),
  }),
  challenge: z.string().min(1).max(2048).optional(),
  event: z.unknown().optional(),
});
interface SubscriptionRow {
  world_id: string;
  channel_id: string;
  type: string;
  provider_id: string | null;
  status: string;
  twitch_id: string;
  condition: unknown;
}
export async function handleWebhook(
  pool: pg.Pool,
  config: TwitchConfig,
  headers: Record<string, string | string[] | undefined>,
  raw: Buffer,
): Promise<string | null> {
  const receipt = verifyWebhook(headers, raw, config.webhookSecret);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new ControlError(400, 'INVALID_EVENT');
  }
  const parsed = bodySchema.safeParse(value);
  if (!parsed.success) throw new ControlError(400, 'INVALID_EVENT');
  const body = parsed.data,
    sub = body.subscription;
  if (
    subscriptionVersions[sub.type] !== sub.version ||
    headers['twitch-eventsub-subscription-type'] !== sub.type ||
    headers['twitch-eventsub-subscription-version'] !== sub.version ||
    sub.transport.callback !== `${config.origin}/webhooks/twitch`
  )
    throw new ControlError(403, 'UNKNOWN_SUBSCRIPTION');
  return transaction(pool, async (client) => {
    // The channel lock comes before subscription/receipt locks, matching reconciliation and game writers.
    let found = (
      await client.query<SubscriptionRow>(
        `select s.*,c.twitch_id from twitch_subscriptions s join channels c on c.world_id=s.world_id and c.id=s.channel_id join worlds w on w.id=s.world_id
      where w.mode='live' and s.type=$1 and s.version=$2 and s.condition=$3::jsonb and (s.provider_id=$4 or (s.provider_id is null and s.status='creating')) order by s.world_id,s.channel_id for update of c`,
        [sub.type, sub.version, JSON.stringify(sub.condition), sub.id],
      )
    ).rows[0];
    if (found === undefined) throw new ControlError(403, 'UNKNOWN_SUBSCRIPTION');
    // Re-read after acquiring the channel lock: another callback may have changed the registry while this query waited.
    const current = (
      await client.query<SubscriptionRow>(
        "select * from twitch_subscriptions where world_id=$1 and channel_id=$2 and type=$3 and version=$4 and condition=$5::jsonb and (provider_id=$6 or (provider_id is null and status='creating'))",
        [
          found.world_id,
          found.channel_id,
          sub.type,
          sub.version,
          JSON.stringify(sub.condition),
          sub.id,
        ],
      )
    ).rows[0];
    if (current === undefined) throw new ControlError(403, 'UNKNOWN_SUBSCRIPTION');
    found = { ...current, twitch_id: found.twitch_id };
    const hash = sha256Hex(raw.toString('utf8'));
    const inserted = await client.query(
      'insert into twitch_receipts(message_id,payload_hash) values($1,$2) on conflict do nothing',
      [receipt.id, hash],
    );
    if (inserted.rowCount !== 1) {
      const prior = (
        await client.query<{ payload_hash: string }>(
          'select payload_hash from twitch_receipts where message_id=$1',
          [receipt.id],
        )
      ).rows[0];
      if (prior?.payload_hash !== hash) throw new ControlError(409, 'RECEIPT_CONFLICT');
      return receipt.kind === 'webhook_callback_verification' ? (body.challenge ?? null) : null;
    }
    if (receipt.kind === 'webhook_callback_verification') {
      if (
        body.challenge === undefined ||
        !['creating', 'webhook_callback_verification_pending', 'enabled'].includes(found.status)
      )
        throw new ControlError(400, 'INVALID_CHALLENGE');
      await client.query(
        "update twitch_subscriptions set provider_id=$4,status='enabled',verified_at=clock_timestamp() where world_id=$1 and channel_id=$2 and type=$3",
        [found.world_id, found.channel_id, sub.type, sub.id],
      );
      return body.challenge;
    }
    const scope = {
      worldId: found.world_id,
      channelId: found.channel_id,
      requiredMode: 'live' as const,
    };
    if (receipt.kind === 'revocation') {
      await client.query(
        'update twitch_subscriptions set status=$4 where world_id=$1 and channel_id=$2 and type=$3',
        [found.world_id, found.channel_id, sub.type, sub.status],
      );
      await client.query(
        "update twitch_channels set input_error='SUBSCRIPTION_REVOKED' where world_id=$1 and channel_id=$2",
        [found.world_id, found.channel_id],
      );
      await acceptInputInTransaction(client, {
        ...scope,
        provider: 'twitch-eventsub',
        messageId: receipt.id,
        command: { type: 'interrupt', reason: 'input_outage' },
      });
      return null;
    }
    if (found.status !== 'enabled') throw new ControlError(409, 'SUBSCRIPTION_NOT_READY');
    if (sub.type === 'channel.chat.message') {
      const bot = (
        await client.query<{ subject: string }>(
          "select subject from oauth_grants where world_id=$1 and purpose='bot' and revoked_at is null",
          [found.world_id],
        )
      ).rows[0];
      if (bot === undefined) return null;
      const chat = normalizeChat(body.event, {
        ...scope,
        twitchId: found.twitch_id,
        botId: bot.subject,
        actorSecret: config.actorKey,
      });
      if (chat === null) return null;
      if (chat.intent === 'help') {
        // One shared help response per minute, independent of the number of viewers asking.
        await client.query(
          `insert into bot_messages(world_id,channel_id,key,message) values($1,$2,$3,'Ripple: vote with !ripple 1, !ripple 2 or !ripple 3. Your first valid vote stands. Ordinary local chat shapes the habitat; repeated messages add no extra activity within ten seconds.') on conflict do nothing`,
          [found.world_id, found.channel_id, `help:${Math.floor(Date.now() / 60000)}`],
        );
        return null;
      }
      // Semantic identity also deduplicates the same chat delivered through a second subscription.
      const prior = await client.query(
        'select 1 from inbox where world_id=$1 and provider=$2 and message_id=$3',
        [found.world_id, 'twitch-chat', chat.semanticId],
      );
      if (prior.rowCount === 0)
        await acceptInputInTransaction(client, {
          ...scope,
          provider: 'twitch-chat',
          messageId: chat.semanticId,
          command: chat.intent,
        });
      return null;
    }
    const event = z.object({ broadcaster_user_id: z.string() }).safeParse(body.event);
    if (!event.success || event.data.broadcaster_user_id !== found.twitch_id)
      throw new ControlError(400, 'INVALID_EVENT');
    if (sub.type === 'channel.update') {
      const category = z.object({ category_id: z.string().max(100) }).safeParse(body.event);
      if (!category.success) throw new ControlError(400, 'INVALID_EVENT');
      const previous = (
        await client.query<{ category_id: string | null }>(
          'select category_id from twitch_channels where world_id=$1 and channel_id=$2',
          [found.world_id, found.channel_id],
        )
      ).rows[0];
      const changed = await client.query(
        'update twitch_channels set category_id=$3,category_at=$4 where world_id=$1 and channel_id=$2 and (category_at is null or category_at<$4)',
        [found.world_id, found.channel_id, category.data.category_id, new Date(receipt.timestamp)],
      );
      if (
        changed.rowCount === 1 &&
        previous?.category_id !== undefined &&
        previous.category_id !== null &&
        previous.category_id !== category.data.category_id
      )
        await acceptInputInTransaction(client, {
          ...scope,
          provider: 'twitch-eventsub',
          messageId: receipt.id,
          command: { type: 'shock', kind: 'category_change' },
        });
    } else {
      const changed = await client.query(
        'update twitch_channels set lifecycle_at=$3 where world_id=$1 and channel_id=$2 and (lifecycle_at is null or lifecycle_at<$3)',
        [found.world_id, found.channel_id, new Date(receipt.timestamp)],
      );
      if (changed.rowCount === 1)
        await acceptInputInTransaction(client, {
          ...scope,
          provider: 'twitch-eventsub',
          messageId: receipt.id,
          command: { type: 'stream', online: sub.type === 'stream.online' },
        });
    }
    return null;
  });
}
export async function registerWebhook(
  app: FastifyInstance,
  pool: pg.Pool,
  config: TwitchConfig,
): Promise<void> {
  await app.register((scope, _options, done) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );
    scope.post('/webhooks/twitch', { bodyLimit: 64 * 1024 }, async (request, reply) => {
      try {
        const challenge = await handleWebhook(
          pool,
          config,
          request.headers,
          request.body as Buffer,
        );
        return challenge === null
          ? await reply.code(204).send()
          : await reply.type('text/plain').send(challenge);
      } catch (error) {
        if (error instanceof ControlError)
          return await reply.code(error.status).send(errorBody(error.code, error.code, request.id));
        throw error;
      }
    });
    done();
  });
}
