import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { buildApp } from '../app.ts';
import { TwitchClient } from './client.ts';
import type { TwitchConfig } from './security.ts';
import { processNextInput } from '../game/worker.ts';

describe('browser-bound broadcaster and operator OAuth', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool, app: FastifyInstance;
  const config: TwitchConfig = {
    origin: 'https://ripple.example',
    clientId: 'oauth-test',
    clientSecret: 'secret',
    webhookSecret: 's'.repeat(64),
    encryptionKey: randomBytes(32).toString('base64'),
    actorKey: randomBytes(32).toString('base64'),
    operatorSecret: 'o'.repeat(40),
  };
  let exchanges = 0;
  let ownerCookies: Record<string, string> = {};
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    const api = new TwitchClient(config, (async (url, init) => {
      if (String(url).endsWith('/token')) {
        exchanges++;
        const code = new URLSearchParams(String(init?.body)).get('code');
        return Response.json({
          access_token: code ?? 'owner',
          refresh_token: 'private-refresh',
          expires_in: 3600,
        });
      }
      const bot = new Headers(init?.headers).get('Authorization') === 'OAuth bot';
      return Response.json({
        client_id: config.clientId,
        user_id: bot ? '999' : '123',
        login: bot ? 'bot' : 'owner',
        scopes: bot ? ['user:bot', 'user:read:chat', 'user:write:chat'] : ['channel:bot'],
        expires_in: 3600,
      });
    }) as typeof fetch);
    app = await buildApp({
      config: { logLevel: 'silent', webRoot: undefined, twitch: config },
      pool,
      twitchApi: api,
    });
    await app.ready();
  }, 20000);
  afterAll(async () => {
    await app.close();
    await pool.end();
    await temporary.drop();
  });
  it('rejects state theft and reuse, stores only encrypted grants, and issues scoped owner cookies', async () => {
    const start = await app.inject({ url: '/auth/twitch/start' });
    expect(start.statusCode).toBe(302);
    const state = new URL(String(start.headers.location)).searchParams.get('state');
    const browser = start.cookies[0]!;
    const url = `/auth/twitch/callback?state=${state}&code=owner`;
    expect((await app.inject({ url })).statusCode).toBe(400);
    const callback = await app.inject({ url, cookies: { [browser.name]: browser.value } });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/controller');
    ownerCookies = Object.fromEntries(callback.cookies.map((c) => [c.name, c.value]));
    expect(callback.cookies.map((c) => c.name)).toEqual([
      '__Host-ripple-session',
      '__Host-ripple-csrf',
    ]);
    expect(callback.cookies[0]).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
    });
    expect((await app.inject({ url, cookies: { [browser.name]: browser.value } })).statusCode).toBe(
      400,
    );
    expect(exchanges).toBe(1);
    const grant = (await pool.query('select * from oauth_grants')).rows[0];
    expect(grant?.subject).toBe('123');
    expect(JSON.stringify(grant?.encrypted_tokens)).not.toContain('private-refresh');
    expect((await pool.query('select * from controller_sessions')).rowCount).toBe(1);
  });
  it('requires operator authorization and exact origin for the separate bot grant', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/auth/twitch/bot/start',
          payload: { operatorSecret: config.operatorSecret },
        })
      ).statusCode,
    ).toBe(403);
    const start = await app.inject({
      method: 'POST',
      url: '/auth/twitch/bot/start',
      headers: { origin: config.origin },
      payload: { operatorSecret: config.operatorSecret },
    });
    expect(start.statusCode).toBe(200);
    const state = new URL(
      start.json<{ authorizationUrl: string }>().authorizationUrl,
    ).searchParams.get('state');
    const browser = start.cookies[0]!;
    const callback = await app.inject({
      url: `/auth/twitch/callback?state=${state}&code=bot`,
      cookies: { [browser.name]: browser.value },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.cookies).toHaveLength(0);
    expect(
      (await pool.query("select channel_id,subject from oauth_grants where purpose='bot'")).rows,
    ).toEqual([{ channel_id: null, subject: '999' }]);
  });
  it('enforces ownership, CSRF, expected versions and idempotency before a named seed commits', async () => {
    const status = await app.inject({ url: '/api/controller/status', cookies: ownerCookies });
    expect(status.statusCode).toBe(200);
    const owner = status.json<{ worldId: string; channelId: string; csrfToken: string }>();
    await acceptInput(pool, {
      worldId: owner.worldId,
      channelId: owner.channelId,
      provider: 'test-setup',
      messageId: 'healthy',
      command: { type: 'integration', online: true, healthy: true },
      requiredMode: 'live',
    });
    await processNextInput(pool, owner.worldId, owner.channelId);
    const key = '11111111-1111-4111-8111-111111111111',
      url = `/api/channels/${owner.channelId}/seed`,
      payload = { expectedVersion: 1, name: '<Shell & Tide>' };
    const headers = {
      origin: config.origin,
      'x-csrf-token': owner.csrfToken,
      'idempotency-key': key,
    };
    expect(
      (await app.inject({ method: 'POST', url, cookies: ownerCookies, payload })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/00000000-0000-4000-8000-000000000000/seed`,
          cookies: ownerCookies,
          headers,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          cookies: ownerCookies,
          headers,
          payload: { ...payload, expectedVersion: 0 },
        })
      ).statusCode,
    ).toBe(409);
    const accepted = await app.inject({
      method: 'POST',
      url,
      cookies: ownerCookies,
      headers,
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    const retry = await app.inject({
      method: 'POST',
      url,
      cookies: ownerCookies,
      headers,
      payload,
    });
    expect(retry.json<{ sequence: number; duplicate: boolean }>()).toMatchObject({
      sequence: accepted.json<{ sequence: number }>().sequence,
      duplicate: true,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          cookies: ownerCookies,
          headers,
          payload: { ...payload, name: 'Different' },
        })
      ).statusCode,
    ).toBe(409);
    await processNextInput(pool, owner.worldId, owner.channelId);
    const result = await app.inject({
      url: `/api/controller/commands/${key}`,
      cookies: ownerCookies,
    });
    expect(result.json<{ result: { code: string } }>().result.code).toBe('APPLIED');
    expect((await pool.query('select name from organisms')).rows).toEqual([
      { name: '<Shell & Tide>' },
    ]);
    const read = await app.inject({
      method: 'POST',
      url: '/api/controller/read-capability',
      cookies: ownerCookies,
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: '/api/controller/status',
          headers: { authorization: `Bearer ${read.json<{ capability: string }>().capability}` },
        })
      ).statusCode,
    ).toBe(401);
  });
});
