import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { registerWebhook } from './webhook.ts';
import { ensureInstallation, enrollChannel } from './installation.ts';
import { storeGrant } from './grants.ts';
import { processNextInput } from '../game/worker.ts';
import { syntheticSeedCommand } from '../game/sandbox.ts';
import type { TwitchConfig } from './security.ts';

describe('signed EventSub intake in PostgreSQL', () => {
  let temporary: TemporaryDatabase,
    pool: pg.Pool,
    app: FastifyInstance,
    worldId: string,
    channelId: string;
  const config: TwitchConfig = {
    origin: 'https://ripple.example',
    clientId: 'webhook-test',
    clientSecret: 'secret',
    webhookSecret: 's'.repeat(64),
    encryptionKey: randomBytes(32).toString('base64'),
    actorKey: randomBytes(32).toString('base64'),
    operatorSecret: 'o'.repeat(40),
  };
  const condition = { broadcaster_user_id: '123', user_id: '999' };
  const subscription = {
    id: 'subscription-one',
    type: 'channel.chat.message',
    version: '1',
    status: 'enabled',
    condition,
    transport: { method: 'webhook', callback: `${config.origin}/webhooks/twitch` },
  };
  const chat = {
    broadcaster_user_id: '123',
    chatter_user_id: '456',
    message_id: 'chat-one',
    message: { text: '!ripple 2' },
    message_type: 'text',
    source_broadcaster_user_id: null,
    source_message_id: null,
  };
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    worldId = await ensureInstallation(pool, config);
    channelId = await transaction(pool, (c) => enrollChannel(c, worldId, '123', 'owner'));
    await transaction(pool, (c) =>
      storeGrant(
        c,
        config,
        worldId,
        null,
        'bot',
        { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
        {
          client_id: config.clientId,
          user_id: '999',
          scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
          expires_in: 3600,
        },
      ),
    );
    await pool.query(
      "insert into twitch_subscriptions(world_id,channel_id,type,version,condition,status) values($1,$2,'channel.chat.message','1',$3,'creating')",
      [worldId, channelId, JSON.stringify(condition)],
    );
    app = Fastify();
    await registerWebhook(app, pool, config);
    await app.ready();
  }, 20000);
  afterAll(async () => {
    await app.close();
    await pool.end();
    await temporary.drop();
  });
  function signed(
    body: unknown,
    kind = 'notification',
    id = randomUUID(),
    signatureOverride?: string,
  ) {
    const raw = JSON.stringify(body),
      timestamp = new Date().toISOString();
    return app.inject({
      method: 'POST',
      url: '/webhooks/twitch',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': id,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': kind,
        'twitch-eventsub-subscription-type': 'channel.chat.message',
        'twitch-eventsub-subscription-version': '1',
        'twitch-eventsub-message-signature':
          signatureOverride ??
          `sha256=${createHmac('sha256', config.webhookSecret)
            .update(id + timestamp + raw)
            .digest('hex')}`,
      },
      payload: raw,
    });
  }
  it('binds a pending subscription challenge before the create response and rejects unauthenticated bytes', async () => {
    expect(
      (
        await signed(
          { subscription, challenge: 'verify-me' },
          'webhook_callback_verification',
          randomUUID(),
          'sha256=' + '0'.repeat(64),
        )
      ).statusCode,
    ).toBe(403);
    const response = await signed(
      { subscription, challenge: 'verify-me' },
      'webhook_callback_verification',
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('verify-me');
    expect((await pool.query('select status,provider_id from twitch_subscriptions')).rows).toEqual([
      { status: 'enabled', provider_id: 'subscription-one' },
    ]);
    expect(
      (
        await signed({
          subscription: {
            ...subscription,
            condition: { broadcaster_user_id: '777', user_id: '999' },
          },
          event: chat,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('acknowledges duplicate delivery and semantic chat identity without retaining text or extra votes', async () => {
    for (const command of [
      { type: 'integration', online: true, healthy: true },
      syntheticSeedCommand(),
    ]) {
      await acceptInput(pool, {
        worldId,
        channelId,
        provider: 'setup',
        messageId: randomUUID(),
        command,
        requiredMode: 'live',
      });
      await processNextInput(pool, worldId, channelId);
    }
    const id = randomUUID(),
      body = { subscription, event: chat };
    expect((await signed(body, 'notification', id)).statusCode).toBe(204);
    expect((await signed(body, 'notification', id)).statusCode).toBe(204);
    await processNextInput(pool, worldId, channelId);
    expect((await signed(body)).statusCode).toBe(204);
    expect(
      (await pool.query("select command from inbox where provider='twitch-chat'")).rowCount,
    ).toBe(1);
    expect((await pool.query('select * from votes')).rowCount).toBe(1);
    expect(JSON.stringify((await pool.query('select command from inbox')).rows)).not.toContain(
      '!ripple',
    );
    expect(
      (
        await signed(
          { ...body, event: { ...chat, message: { text: '!ripple 3' } } },
          'notification',
          id,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await signed({
          subscription,
          event: {
            ...chat,
            message_id: 'mirrored',
            source_broadcaster_user_id: '777',
            source_message_id: 'origin',
          },
        })
      ).statusCode,
    ).toBe(204);
    expect((await pool.query('select * from votes')).rowCount).toBe(1);
  });
  it('records revoked input as an interruption before acknowledging', async () => {
    expect(
      (
        await signed(
          { subscription: { ...subscription, status: 'authorization_revoked' } },
          'revocation',
        )
      ).statusCode,
    ).toBe(204);
    expect((await processNextInput(pool, worldId, channelId))?.effect.code).toBe('APPLIED');
    expect((await pool.query('select healthy from channels')).rows[0]?.healthy).toBe(false);
    expect((await pool.query('select phase from rounds')).rows[0]?.phase).toBe('INTERRUPTED');
  });
});
