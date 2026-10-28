import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { ensureInstallation, enrollChannel } from './installation.ts';
import { storeGrant } from './grants.ts';
import { registerWebhook } from './webhook.ts';
import type { TwitchConfig } from './security.ts';
import { processNextInput } from '../game/worker.ts';
import { syntheticSeedCommand } from '../game/sandbox.ts';
import { readSnapshot } from '../game/snapshot.ts';
import type { TransferRow } from '../game/propagation-store.ts';
describe('signed outgoing Twitch raids', () => {
  let temporary: TemporaryDatabase,
    pool: pg.Pool,
    app: FastifyInstance,
    worldId: string,
    source: string,
    target: string;
  const config: TwitchConfig = {
    origin: 'https://ripple.example',
    clientId: 'raid-test',
    clientSecret: 'secret',
    webhookSecret: 's'.repeat(64),
    encryptionKey: randomBytes(32).toString('base64'),
    actorKey: randomBytes(32).toString('base64'),
    sessionSecret: randomBytes(32).toString('base64'),
    operatorSecret: 'o'.repeat(40),
  };
  const sub = {
    id: 'outgoing-raid',
    type: 'channel.raid',
    version: '1',
    status: 'enabled',
    condition: { from_broadcaster_user_id: '123' },
    transport: { method: 'webhook', callback: `${config.origin}/webhooks/twitch` },
  };
  const event = {
    from_broadcaster_user_id: '123',
    to_broadcaster_user_id: '456',
    from_broadcaster_user_name: 'Unstored source name',
    to_broadcaster_user_name: 'Unstored target name',
    viewers: 9001,
  };
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    worldId = await ensureInstallation(pool, config);
    [source, target] = await transaction(pool, async (client) => {
      const a = await enrollChannel(client, worldId, '123', 'source'),
        b = await enrollChannel(client, worldId, '456', 'target');
      for (const [subject, channelId] of [
        ['123', a],
        ['456', b],
        ['999', null],
      ] as const)
        await storeGrant(
          client,
          config,
          worldId,
          channelId,
          channelId === null ? 'bot' : 'broadcaster',
          { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 },
          {
            client_id: config.clientId,
            user_id: subject,
            scopes:
              channelId === null
                ? ['user:bot', 'user:read:chat', 'user:write:chat']
                : ['channel:bot'],
            expires_in: 3600,
          },
        );
      return [a, b] as const;
    });
    for (const channelId of [source, target]) {
      for (const command of [
        { type: 'integration', online: true, healthy: true },
        syntheticSeedCommand(),
      ]) {
        await acceptInput(pool, {
          worldId,
          channelId,
          provider: 'fixture',
          messageId: randomUUID(),
          command,
          requiredMode: 'live',
        });
        await processNextInput(pool, worldId, channelId);
      }
    }
    await pool.query(
      "update twitch_channels set visitor_policy='accept' where world_id=$1 and channel_id=$2",
      [worldId, target],
    );
    await pool.query(
      "insert into twitch_subscriptions(world_id,channel_id,type,version,provider_id,condition,status,verified_at) values($1,$2,'channel.raid','1',$3,$4,'enabled',clock_timestamp())",
      [worldId, source, sub.id, JSON.stringify(sub.condition)],
    );
    app = Fastify();
    await registerWebhook(app, pool, config);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await temporary.drop();
  });
  async function signed(body: unknown, id = randomUUID()) {
    const raw = JSON.stringify(body),
      timestamp = new Date().toISOString();
    return app.inject({
      method: 'POST',
      url: '/webhooks/twitch',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': id,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-subscription-type': 'channel.raid',
        'twitch-eventsub-subscription-version': '1',
        'twitch-eventsub-message-signature': `sha256=${createHmac('sha256', config.webhookSecret)
          .update(id + timestamp + raw)
          .digest('hex')}`,
      },
      payload: raw,
    });
  }
  it('acknowledges durable receipt, creates one bounded child, and keeps the destination ballot unchanged', async () => {
    const previous = await readSnapshot(pool, worldId, target),
      id = randomUUID();
    expect((await signed({ subscription: sub, event }, id)).statusCode).toBe(204);
    expect((await signed({ subscription: sub, event }, id)).statusCode).toBe(204);
    const input = (
      await pool.query<{ command: unknown }>(
        "select command from inbox where world_id=$1 and provider='twitch-raid'",
        [worldId],
      )
    ).rows;
    expect(input).toHaveLength(1);
    expect(JSON.stringify(input)).not.toContain('viewers');
    expect(JSON.stringify(input)).not.toContain('Unstored');
    expect(
      (await pool.query('select 1 from transfers where world_id=$1', [worldId])).rowCount,
    ).toBe(0);
    await processNextInput(pool, worldId, source);
    await processNextInput(pool, worldId, target);
    const transfers = (
      await pool.query<TransferRow>('select * from transfers where world_id=$1', [worldId])
    ).rows;
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.outcome).toBe('ACTIVE');
    expect(transfers[0]?.snapshot.arrival?.health).toBe(32);
    expect((await readSnapshot(pool, worldId, target))?.payload.round?.id).toBe(
      previous?.payload.round?.id,
    );
    expect((await pool.query('select 1 from votes where world_id=$1', [worldId])).rowCount).toBe(0);
    expect(
      (await pool.query('select 1 from activity_contributions where world_id=$1', [worldId]))
        .rowCount,
    ).toBe(0);
  });
  it('rejects an incoming-condition subscription and stops propagation after source consent is revoked', async () => {
    const incoming = {
      ...sub,
      id: 'incoming-not-used',
      condition: { to_broadcaster_user_id: '456' },
    };
    await pool.query(
      "insert into twitch_subscriptions(world_id,channel_id,type,version,provider_id,condition,status,verified_at) values($1,$2,'channel.raid','1',$3,$4,'enabled',clock_timestamp())",
      [worldId, target, incoming.id, JSON.stringify(incoming.condition)],
    );
    expect((await signed({ subscription: incoming, event })).statusCode).toBe(403);
    await pool.query(
      "update oauth_grants set revoked_at=clock_timestamp() where world_id=$1 and channel_id=$2 and purpose='broadcaster'",
      [worldId, source],
    );
    expect((await signed({ subscription: sub, event })).statusCode).toBe(204);
    await processNextInput(pool, worldId, source);
    expect(
      (
        await pool.query('select 1 from transfers where world_id=$1 and child_id is not null', [
          worldId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          "select 1 from transfers where world_id=$1 and outcome='SOURCE_AUTHORIZATION_REVOKED'",
          [worldId],
        )
      ).rowCount,
    ).toBe(1);
  });
});
