import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { ensureInstallation, enrollChannel } from './installation.ts';
import { storeGrant } from './grants.ts';
import { TwitchClient } from './client.ts';
import { dispatchBotMessage } from './bot.ts';
import type { TwitchConfig } from './security.ts';
describe('bounded bot delivery', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  const config: TwitchConfig = {
    origin: 'https://ripple.example',
    clientId: 'bot-test',
    clientSecret: 'secret',
    webhookSecret: 's'.repeat(64),
    encryptionKey: randomBytes(32).toString('base64'),
    actorKey: randomBytes(32).toString('base64'),
    sessionSecret: randomBytes(32).toString('base64'),
    operatorSecret: 'o'.repeat(40),
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
  it('sends once across concurrent dispatchers and never retries an ambiguous send', async () => {
    const world = await ensureInstallation(pool, config),
      channel = await transaction(pool, (c) => enrollChannel(c, world, '123', 'owner'));
    await transaction(pool, (c) =>
      storeGrant(
        c,
        config,
        world,
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
    await pool.query<Record<string, unknown>>(
      'update channels set online=true,healthy=true where world_id=$1',
      [world],
    );
    await pool.query<Record<string, unknown>>(
      "insert into bot_messages(world_id,channel_id,key,message) values($1,$2,'one','First message'),($1,$2,'two','Second message')",
      [world, channel],
    );
    let sends = 0;
    const api = new TwitchClient(config, async (url, init) => {
      await Promise.resolve();
      if (url.endsWith('/token')) return Response.json({ access_token: 'app', expires_in: 3600 });
      sends++;
      expect(
        JSON.parse(
          typeof init.body === 'string' || init.body instanceof URLSearchParams
            ? init.body.toString()
            : '',
        ),
      ).toMatchObject({
        broadcaster_id: '123',
        sender_id: '999',
        for_source_only: true,
      });
      if (sends === 2) throw new Error('connection lost after upstream accepted');
      return Response.json({ data: [{ message_id: 'sent', is_sent: true }] });
    });
    expect(
      (
        await Promise.all([
          dispatchBotMessage(pool, api, world),
          dispatchBotMessage(pool, api, world),
        ])
      ).sort(),
    ).toEqual([false, true]);
    expect(sends).toBe(1);
    await pool.query<Record<string, unknown>>(
      "update bot_messages set attempt_at=clock_timestamp()-interval '11 seconds' where status='sent'",
    );
    expect(await dispatchBotMessage(pool, api, world)).toBe(true);
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "select count(*)::int as count from bot_messages where status='uncertain'",
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(await dispatchBotMessage(pool, api, world)).toBe(false);
    expect(sends).toBe(2);
    await pool.query<Record<string, unknown>>(
      "insert into bot_messages(world_id,channel_id,key,message,expires_at) values($1,$2,'expired','Stale ballot',clock_timestamp()-interval '1 second')",
      [world, channel],
    );
    await dispatchBotMessage(pool, api, world);
    expect(
      (
        await pool.query<Record<string, unknown>>(
          "select status,error_code from bot_messages where key='expired'",
        )
      ).rows,
    ).toEqual([{ status: 'failed', error_code: 'MESSAGE_EXPIRED' }]);
  });
});
