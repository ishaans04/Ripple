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
import { ControlError } from './sessions.ts';
import type { TwitchConfig } from './security.ts';

describe('optional celebration subscriptions and intake', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  const base: TwitchConfig = {
    origin: 'https://ripple.example',
    clientId: 'celebrations-test',
    clientSecret: 'secret',
    webhookSecret: 's'.repeat(64),
    encryptionKey: randomBytes(32).toString('base64'),
    actorKey: randomBytes(32).toString('base64'),
    operatorSecret: 'o'.repeat(40),
    sessionSecret: Buffer.alloc(32, 7).toString('base64'),
  };
  const enabled = { ...base, celebrations: true };
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
    await temporary.drop();
  });
  async function install(broadcasterScopes: string[]) {
    const world = await ensureInstallation(pool, base);
    const channel = await transaction(pool, async (c) => {
      const id = await enrollChannel(c, world, '123', 'owner');
      for (const purpose of ['bot', 'broadcaster'] as const)
        await storeGrant(
          c,
          base,
          world,
          purpose === 'bot' ? null : id,
          purpose,
          { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
          {
            client_id: base.clientId,
            user_id: purpose === 'bot' ? '999' : '123',
            scopes:
              purpose === 'bot'
                ? ['user:bot', 'user:read:chat', 'user:write:chat']
                : broadcasterScopes,
            expires_in: 3600,
          },
        );
      return id;
    });
    return { world, channel };
  }
  function fakeTwitch(config: TwitchConfig, refuse: ReadonlySet<string>) {
    const created: string[] = [],
      remote: Record<string, unknown>[] = [];
    const api = new TwitchClient(config, async (url, init) => {
      await Promise.resolve();
      if (url.endsWith('/token')) return Response.json({ access_token: 'app', expires_in: 3600 });
      if (init.method === 'POST') {
        const request = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
          type: string;
          version: string;
          condition: Record<string, string>;
          transport: { method: string; callback: string };
        };
        created.push(`${request.type}@${request.version}`);
        // An ineligible channel (for example, no Bits) is refused by Twitch.
        if (refuse.has(request.type))
          return Response.json({ message: 'forbidden' }, { status: 403 });
        const sub = { ...request, id: randomUUID(), status: 'enabled', cost: 0 };
        remote.push(sub);
        return Response.json({ data: [sub], total_cost: 0, max_total_cost: 10000 });
      }
      return Response.json({ data: remote, total_cost: 0, max_total_cost: 10000 });
    });
    return { api, created };
  }

  it('subscribes only to granted kinds when enabled, and an ineligible one never blocks input health', async () => {
    const { world, channel } = await install([
      'channel:bot',
      'bits:read',
      'channel:read:hype_train',
    ]);
    const off = fakeTwitch(base, new Set());
    await reconcileSubscriptions(pool, off.api, world);
    expect(off.created.some((item) => /cheer|subscribe|hype_train/.test(item))).toBe(false);

    const on = fakeTwitch(enabled, new Set(['channel.hype_train.begin']));
    await pool.query(
      "update twitch_subscriptions set attempt_at=clock_timestamp()-interval '1 hour'",
    );
    await reconcileSubscriptions(pool, on.api, world);
    expect(on.created).toContain('channel.cheer@1');
    expect(on.created).toContain('channel.hype_train.begin@2');
    expect(on.created.some((item) => item.startsWith('channel.subscribe@'))).toBe(false);
    const rows = (
      await pool.query<{ type: string; status: string }>(
        'select type,status from twitch_subscriptions where world_id=$1 and channel_id=$2',
        [world, channel],
      )
    ).rows;
    expect(rows.find((row) => row.type === 'channel.hype_train.begin')?.status).not.toBe('enabled');
    // Once every required subscription is verified, health is ready despite the refused optional one.
    await pool.query(
      "update twitch_subscriptions set status='enabled',verified_at=clock_timestamp() where world_id=$1 and type not in ('channel.cheer','channel.subscribe','channel.hype_train.begin')",
      [world],
    );
    await reconcileSubscriptions(pool, on.api, world);
    expect(
      (
        await pool.query<{ input_error: string | null }>(
          'select input_error from twitch_channels where world_id=$1 and channel_id=$2',
          [world, channel],
        )
      ).rows[0]?.input_error,
    ).toBeNull();
  });

  it('turns verified paid events into anonymous capped commands, or ignores them when disabled', async () => {
    const { world, channel } = await install(['channel:bot', 'bits:read']);
    const condition = { broadcaster_user_id: '123' };
    await pool.query(
      `insert into twitch_subscriptions(world_id,channel_id,type,version,condition,status,provider_id,verified_at) values($1,$2,'channel.cheer','1',$3,'enabled','cheer-subscription',clock_timestamp())
      on conflict (world_id,channel_id,type) do update set version=excluded.version,condition=excluded.condition,status=excluded.status,provider_id=excluded.provider_id,verified_at=excluded.verified_at`,
      [world, channel, JSON.stringify(condition)],
    );
    function deliver(config: TwitchConfig, version = '1', broadcaster = '123') {
      const id = randomUUID(),
        timestamp = new Date().toISOString(),
        raw = Buffer.from(
          JSON.stringify({
            subscription: {
              id: 'cheer-subscription',
              type: 'channel.cheer',
              version,
              status: 'enabled',
              condition,
              transport: { method: 'webhook', callback: `${config.origin}/webhooks/twitch` },
            },
            event: {
              broadcaster_user_id: broadcaster,
              user_name: 'GenerousViewer',
              user_id: '777',
              bits: 50000,
              message: 'private cheer text',
              is_anonymous: false,
            },
          }),
        );
      return handleWebhook(
        pool,
        config,
        {
          'twitch-eventsub-message-id': id,
          'twitch-eventsub-message-timestamp': timestamp,
          'twitch-eventsub-message-type': 'notification',
          'twitch-eventsub-subscription-type': 'channel.cheer',
          'twitch-eventsub-subscription-version': version,
          'twitch-eventsub-message-signature': `sha256=${createHmac('sha256', config.webhookSecret)
            .update(id + timestamp + raw.toString('utf8'))
            .digest('hex')}`,
        },
        raw,
      );
    }
    const inbox = async () =>
      (
        await pool.query<{ provider: string; command: unknown }>(
          "select provider,command from inbox where world_id=$1 and channel_id=$2 and provider='twitch-celebration'",
          [world, channel],
        )
      ).rows;
    expect(await deliver(base)).toBeNull();
    expect(await inbox()).toEqual([]);
    expect(await deliver(enabled)).toBeNull();
    const accepted = await inbox();
    expect(accepted).toEqual([
      { provider: 'twitch-celebration', command: { type: 'celebration', kind: 'cheer' } },
    ]);
    const stored = JSON.stringify(
      (await pool.query('select * from inbox where world_id=$1', [world])).rows,
    );
    expect(stored).not.toMatch(/GenerousViewer|777|50000|private cheer text/);
    await expect(deliver(enabled, '2')).rejects.toBeInstanceOf(ControlError);
    await expect(deliver(enabled, '1', '456')).rejects.toMatchObject({ status: 400 });
    expect(await inbox()).toHaveLength(1);
  });
});
