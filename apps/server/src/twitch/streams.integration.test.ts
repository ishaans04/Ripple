import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { ensureInstallation, enrollChannel } from './installation.ts';
import { TwitchClient } from './client.ts';
import { reconcileStreams } from './streams.ts';
import { interruptLiveInput } from './runtime.ts';
import type { TwitchConfig } from './security.ts';
describe('stream recovery reconciliation', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  const config: TwitchConfig = {
    origin: 'https://ripple.example',
    clientId: 'streams-test',
    clientSecret: 'secret',
    webhookSecret: 's'.repeat(64),
    encryptionKey: randomBytes(32).toString('base64'),
    actorKey: randomBytes(32).toString('base64'),
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
  it('does not overwrite a newer webhook with an in-flight REST result, and records disabled intake once', async () => {
    const world = await ensureInstallation(pool, config),
      channel = await transaction(pool, (c) => enrollChannel(c, world, '123', 'owner'));
    const api = new TwitchClient(config, (async (url) => {
      if (String(url).endsWith('/token'))
        return Response.json({ access_token: 'app', expires_in: 3600 });
      if (String(url).includes('/streams?')) {
        await pool.query(
          "update twitch_channels set lifecycle_at=clock_timestamp(),category_at=clock_timestamp(),category_id='newer' where world_id=$1 and channel_id=$2",
          [world, channel],
        );
        return Response.json({ data: [] });
      }
      return Response.json({ data: [{ broadcaster_id: '123', game_id: 'older' }] });
    }) as typeof fetch);
    await reconcileStreams(pool, api, world);
    expect((await pool.query('select category_id from twitch_channels')).rows[0]?.category_id).toBe(
      'newer',
    );
    expect((await pool.query('select * from inbox')).rowCount).toBe(0);
    await interruptLiveInput(pool, 'LIVE_TWITCH_DISABLED');
    await interruptLiveInput(pool, 'LIVE_TWITCH_DISABLED');
    expect((await pool.query('select command from inbox')).rows).toEqual([
      { command: { type: 'interrupt', reason: 'input_outage' } },
    ]);
  });
});
