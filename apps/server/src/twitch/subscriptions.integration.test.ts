import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { ensureInstallation, enrollChannel } from './installation.ts';
import { storeGrant } from './grants.ts';
import { TwitchClient } from './client.ts';
import { reconcileSubscriptions } from './subscriptions.ts';
import { handleWebhook } from './webhook.ts';
import { processNextInput } from '../game/worker.ts';
import type { TwitchConfig } from './security.ts';
describe('subscription reconciliation', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  const config: TwitchConfig = {
    origin: 'https://ripple.example',
    clientId: 'subscriptions-test',
    clientSecret: 'secret',
    webhookSecret: 's'.repeat(64),
    encryptionKey: randomBytes(32).toString('base64'),
    actorKey: randomBytes(32).toString('base64'),
    operatorSecret: 'o'.repeat(40),
    sessionSecret: Buffer.alloc(32, 19).toString('base64'),
  };
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
    await temporary.drop();
  });
  it('creates each subscription once and preserves a challenge that beats the create response', async () => {
    const world = await ensureInstallation(pool, config);
    const channel = await transaction(pool, async (c) => {
      const id = await enrollChannel(c, world, '123', 'owner');
      for (const purpose of ['bot', 'broadcaster'] as const)
        await storeGrant(
          c,
          config,
          world,
          purpose === 'bot' ? null : id,
          purpose,
          { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
          {
            client_id: config.clientId,
            user_id: purpose === 'bot' ? '999' : '123',
            scopes:
              purpose === 'bot'
                ? ['user:bot', 'user:read:chat', 'user:write:chat']
                : ['channel:bot'],
            expires_in: 3600,
          },
        );
      return id;
    });
    let creates = 0,
      deletes = 0;
    const remote: Record<string, unknown>[] = [];
    const api = new TwitchClient(config, (async (url, init) => {
      if (String(url).endsWith('/token'))
        return Response.json({ access_token: 'app', expires_in: 3600 });
      if (init?.method === 'DELETE') {
        deletes++;
        return new Response(null, { status: 204 });
      }
      if (init?.method === 'POST') {
        creates++;
        const request = JSON.parse(String(init.body)) as {
          type: string;
          version: string;
          condition: Record<string, string>;
          transport: { callback: string; method: string };
        };
        const sub = { ...request, id: randomUUID(), status: 'enabled', cost: 0 };
        remote.push(sub);
        const raw = Buffer.from(JSON.stringify({ subscription: sub, challenge: 'challenge' })),
          id = randomUUID(),
          timestamp = new Date().toISOString();
        expect(
          await handleWebhook(
            pool,
            config,
            {
              'twitch-eventsub-message-id': id,
              'twitch-eventsub-message-timestamp': timestamp,
              'twitch-eventsub-message-type': 'webhook_callback_verification',
              'twitch-eventsub-subscription-type': sub.type,
              'twitch-eventsub-subscription-version': sub.version,
              'twitch-eventsub-message-signature': `sha256=${createHmac(
                'sha256',
                config.webhookSecret,
              )
                .update(id + timestamp)
                .update(raw)
                .digest('hex')}`,
            },
            raw,
          ),
        ).toBe('challenge');
        return Response.json({
          data: [{ ...sub, status: 'webhook_callback_verification_pending' }],
          total_cost: 0,
          max_total_cost: 10000,
        });
      }
      return Response.json({ data: remote, total_cost: 0, max_total_cost: 10000, pagination: {} });
    }) as typeof fetch);
    await Promise.all([
      reconcileSubscriptions(pool, api, world),
      reconcileSubscriptions(pool, api, world),
    ]);
    expect(creates).toBe(4);
    expect(
      (
        await pool.query(
          "select * from twitch_subscriptions where status='enabled' and verified_at is not null",
        )
      ).rowCount,
    ).toBe(4);
    while (await processNextInput(pool, world, channel));
    expect((await pool.query('select healthy from channels')).rows[0]?.healthy).toBe(true);
    await reconcileSubscriptions(pool, api, world);
    expect(creates).toBe(4);
    expect(deletes).toBe(0);
  }, 20000);
});
