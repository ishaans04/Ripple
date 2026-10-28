import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { TwitchClient } from './client.ts';
import { maintainGrant, storeGrant, type GrantRow } from './grants.ts';
import { ensureInstallation, enrollChannel } from './installation.ts';
import type { TwitchConfig } from './security.ts';
describe('grant lifecycle in PostgreSQL', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  const config: TwitchConfig = {
    origin: 'https://ripple.example',
    clientId: 'grant-test',
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
  it('serializes an expired refresh, saves its rotated token, and ends revoked sessions', async () => {
    const world = await ensureInstallation(pool, config);
    const channel = await transaction(pool, async (c) => {
      const id = await enrollChannel(c, world, '123', 'owner');
      await storeGrant(
        c,
        config,
        world,
        id,
        'broadcaster',
        { access_token: 'old', refresh_token: 'old-refresh', expires_in: 1 },
        {
          client_id: config.clientId,
          user_id: '123',
          login: 'owner',
          scopes: ['channel:bot'],
          expires_in: 1,
        },
      );
      return id;
    });
    await pool.query("update oauth_grants set expires_at=clock_timestamp()-interval '1 second'");
    const grant = (await pool.query<GrantRow>('select * from oauth_grants')).rows[0]!;
    let refreshes = 0,
      revoked = false;
    const api = new TwitchClient(config, (async (url, init) => {
      if (String(url).endsWith('/token')) {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 });
      }
      if (revoked || new Headers(init?.headers).get('Authorization') === 'OAuth old')
        return new Response(null, { status: 401 });
      return Response.json({
        client_id: config.clientId,
        user_id: '123',
        scopes: ['channel:bot'],
        expires_in: 3600,
      });
    }) as typeof fetch);
    const results = await Promise.all([
      maintainGrant(pool, api, grant, true),
      maintainGrant(pool, api, grant, true),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(refreshes).toBe(1);
    await pool.query(
      "insert into controller_sessions(hash,world_id,channel_id,subject,csrf_hash,expires_at) values ('session',$1,$2,'123','csrf',clock_timestamp()+interval '1 hour')",
      [world, channel],
    );
    revoked = true;
    await expect(maintainGrant(pool, api, grant, true)).rejects.toThrow('GRANT_REVOKED');
    expect((await pool.query('select * from controller_sessions')).rowCount).toBe(0);
    expect(
      (await pool.query('select revoked_at from oauth_grants')).rows[0]?.revoked_at,
    ).toBeInstanceOf(Date);
    expect((await pool.query('select command from inbox')).rows[0]?.command).toEqual({
      type: 'interrupt',
      reason: 'input_outage',
    });
  });
});
