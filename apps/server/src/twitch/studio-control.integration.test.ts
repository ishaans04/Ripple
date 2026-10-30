import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  defaultStudioSettings,
  founderShell,
  studioStateSchema,
  type GameCommand,
  type StudioChallenge,
} from '@ripple/contracts';
import { sha256Hex } from '@ripple/engine';
import { buildApp } from '../app.ts';
import { processNextInput } from '../game/worker.ts';
import { syntheticSeedCommand } from '../game/sandbox.ts';
import { ensureInstallation, enrollChannel } from './installation.ts';
import { storeGrant } from './grants.ts';
import { opaqueToken, privateHash, type TwitchConfig } from './security.ts';

describe('studio routes', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool, app: FastifyInstance;
  let worldId: string, channel: string, other: string;
  const config: TwitchConfig = {
    origin: 'https://ripple.example',
    clientId: 'studio-test',
    clientSecret: 'secret',
    webhookSecret: 's'.repeat(64),
    encryptionKey: randomBytes(32).toString('base64'),
    actorKey: randomBytes(32).toString('base64'),
    sessionSecret: randomBytes(32).toString('base64'),
    operatorSecret: 'o'.repeat(40),
  };
  const owner = { session: opaqueToken(), csrf: opaqueToken() };
  const artist = { session: opaqueToken(), csrf: opaqueToken() };
  const ownerCookies = { '__Host-ripple-session': owner.session, '__Host-ripple-csrf': owner.csrf };
  const artistCookies = {
    '__Host-ripple-artist': artist.session,
    '__Host-ripple-artist-csrf': artist.csrf,
  };
  const artistKey = () => privateHash(config.sessionSecret, 'artist', worldId, '777');
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    worldId = await ensureInstallation(pool, config);
    [channel, other] = await transaction(pool, async (client) => {
      const a = await enrollChannel(client, worldId, '123', 'studio_owner');
      const b = await enrollChannel(client, worldId, '456', 'other_owner');
      for (const [subject, channelId] of [
        ['123', a],
        ['456', b],
      ] as const)
        await storeGrant(
          client,
          config,
          worldId,
          channelId,
          'broadcaster',
          { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 },
          {
            client_id: config.clientId,
            user_id: subject,
            scopes: ['channel:bot'],
            expires_in: 3600,
          },
        );
      await client.query(
        "insert into controller_sessions(hash,world_id,channel_id,subject,csrf_hash,expires_at) values($1,$2,$3,'123',$4,clock_timestamp()+interval '1 hour')",
        [
          privateHash(config.sessionSecret, 'session', owner.session),
          worldId,
          a,
          privateHash(config.sessionSecret, 'csrf', owner.csrf),
        ],
      );
      await client.query(
        "insert into artist_sessions(hash,world_id,artist_key,login,csrf_hash,expires_at) values($1,$2,$3,'shell_maker',$4,clock_timestamp()+interval '1 hour')",
        [
          privateHash(config.sessionSecret, 'artist-session', artist.session),
          worldId,
          privateHash(config.sessionSecret, 'artist', worldId, '777'),
          privateHash(config.sessionSecret, 'artist-csrf', artist.csrf),
        ],
      );
      return [a, b];
    });
    for (const id of [channel, other]) {
      await send(id, { type: 'integration', online: true, healthy: true });
      await send(id, syntheticSeedCommand());
    }
    app = await buildApp({
      config: { logLevel: 'silent', webRoot: undefined, twitch: config },
      pool,
    });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await temporary.drop();
  });
  async function send(channelId: string, command: GameCommand) {
    await acceptInput(pool, {
      worldId,
      channelId,
      provider: 'fixture',
      messageId: randomUUID(),
      command,
      requiredMode: 'live',
    });
    await settle(channelId);
  }
  async function settle(channelId = channel) {
    while (await processNextInput(pool, worldId, channelId));
  }
  async function version(channelId = channel) {
    return (
      await pool.query<{ state_version: number }>(
        'select state_version from channels where world_id=$1 and id=$2',
        [worldId, channelId],
      )
    ).rows[0]!.state_version;
  }
  async function result(sequence: number, channelId = channel) {
    return (
      await pool.query<{ result: { code: string } }>(
        'select result from game_events where world_id=$1 and channel_id=$2 and sequence=$3',
        [worldId, channelId, sequence],
      )
    ).rows[0]?.result;
  }
  function owned(
    url: string,
    payload: unknown,
    key = randomUUID(),
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url,
      cookies: ownerCookies,
      headers: {
        origin: config.origin,
        'x-csrf-token': owner.csrf,
        'idempotency-key': key,
        ...headers,
      },
      payload: payload as Record<string, unknown>,
    });
  }

  it('records studio settings and manual start only for the owning broadcaster with versions and retries', async () => {
    const settings = {
      ...defaultStudioSettings,
      enabled: true,
      breakScenes: ['BRB'],
      activeScenes: ['Live'],
    };
    const key = randomUUID();
    const response = await owned(
      `/api/channels/${channel}/studio/settings`,
      { expectedVersion: await version(), settings },
      key,
    );
    expect(response.statusCode).toBe(202);
    const retry = await owned(
      `/api/channels/${channel}/studio/settings`,
      { expectedVersion: response.json<{ sequence: number }>().sequence, settings },
      key,
    );
    expect(retry.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    await settle();
    expect(
      (await owned(`/api/channels/${other}/studio/start`, { expectedVersion: 0 })).json(),
    ).toMatchObject({
      error: { code: 'NOT_OWNER' },
    });
    expect(
      (await owned(`/api/channels/${channel}/studio/start`, { expectedVersion: 0 })).json(),
    ).toMatchObject({
      error: { code: 'STALE_VERSION' },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/${channel}/studio/start`,
          cookies: ownerCookies,
          headers: { origin: config.origin, 'idempotency-key': randomUUID() },
          payload: { expectedVersion: await version() },
        })
      ).json(),
    ).toMatchObject({ error: { code: 'CSRF_FAILED' } });
    const started = await owned(`/api/channels/${channel}/studio/start`, {
      expectedVersion: await version(),
    });
    expect(started.statusCode).toBe(202);
    await settle();
    expect(await result(started.json<{ sequence: number }>().sequence)).toMatchObject({
      code: 'APPLIED',
    });
    const announced = (
      await pool.query<{ message: string }>(
        "select message from bot_messages where world_id=$1 and channel_id=$2 and message like 'Cocoon Studio is open%'",
        [worldId, channel],
      )
    ).rows[0];
    // The public origin is inserted only when the bot delivers the message.
    expect(announced?.message).toMatch(/\{origin\}\/studio\?s=[0-9a-f-]{36} /);
  });

  it('serves public studio state and accepts only owned, schema-bound artist proposals in creation', async () => {
    const session = (
      await pool.query<{ id: string; challenge: StudioChallenge }>(
        "select id,challenge from studio_sessions where world_id=$1 and channel_id=$2 and phase='CREATING'",
        [worldId, channel],
      )
    ).rows[0]!;
    const state = studioStateSchema.parse(
      (await app.inject({ url: `/api/studios/${session.id}` })).json(),
    );
    expect(state.studio.session?.phase).toBe('CREATING');
    expect(state.challenge?.studioSessionId).toBe(session.id);
    expect(JSON.stringify(state)).not.toContain(artistKey());
    const challenge = state.challenge!;
    const blueprint = {
      schemaVersion: 1,
      worldId,
      studioSessionId: session.id,
      baseOrganismId: challenge.baseOrganismId,
      baseOrganismVersion: challenge.baseOrganismVersion,
      mutationTemplateId: challenge.mutationTemplateIds[0],
      rendererVersion: 'shell-v1',
      part: founderShell,
    };
    const submit = (payload: unknown, key = randomUUID(), cookies = artistCookies) =>
      app.inject({
        method: 'POST',
        url: `/api/studios/${session.id}/proposals`,
        cookies,
        headers: { origin: config.origin, 'x-csrf-token': artist.csrf, 'idempotency-key': key },
        payload: payload as Record<string, unknown>,
      });
    expect(
      (
        await submit(
          { proposalId: randomUUID(), blueprint, creditOptIn: true },
          randomUUID(),
          {} as never,
        )
      ).json(),
    ).toMatchObject({
      error: { code: 'ARTIST_SIGN_IN_REQUIRED' },
    });
    expect(
      (
        await submit({
          proposalId: randomUUID(),
          blueprint: '<svg onload="x()"/>',
          creditOptIn: true,
        })
      ).json(),
    ).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    // The owner's broadcaster session is not an artist identity.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/studios/${session.id}/proposals`,
          cookies: ownerCookies,
          headers: {
            origin: config.origin,
            'x-csrf-token': owner.csrf,
            'idempotency-key': randomUUID(),
          },
          payload: { proposalId: randomUUID(), blueprint, creditOptIn: true },
        })
      ).json(),
    ).toMatchObject({ error: { code: 'ARTIST_SIGN_IN_REQUIRED' } });
    const key = randomUUID(),
      proposalId = randomUUID();
    const accepted = await submit({ proposalId, blueprint, creditOptIn: true }, key);
    expect(accepted.statusCode).toBe(202);
    expect(
      (await submit({ proposalId: randomUUID(), blueprint, creditOptIn: false }, key)).json(),
    ).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    await settle();
    const status = await app.inject({
      url: `/api/artist/status?studio=${session.id}&operation=${key}`,
      cookies: artistCookies,
    });
    expect(status.json()).toMatchObject({
      signedIn: true,
      login: 'shell_maker',
      proposals: [{ id: proposalId, status: 'active', creditOptIn: true }],
      lastResult: { code: 'APPLIED' },
    });
    const moderation = (
      await app.inject({ url: '/api/controller/studio', cookies: ownerCookies })
    ).json<{
      proposals: { id: string; artistKey: string; credit: string }[];
    }>();
    expect(moderation.proposals).toEqual([
      expect.objectContaining({ id: proposalId, artistKey: artistKey(), credit: 'shell_maker' }),
    ]);
    const removed = await owned(`/api/studios/${session.id}/proposals/${proposalId}/remove`, {
      expectedVersion: await version(),
    });
    expect(removed.statusCode).toBe(202);
    await settle();
    expect(await result(removed.json<{ sequence: number }>().sequence)).toMatchObject({
      code: 'APPLIED',
    });
    const blocked = await owned(`/api/channels/${channel}/studio/blocks`, {
      expectedVersion: await version(),
      artistKey: artistKey(),
      blocked: true,
    });
    await settle();
    expect(await result(blocked.json<{ sequence: number }>().sequence)).toMatchObject({
      code: 'APPLIED',
    });
    const refused = await submit({ proposalId: randomUUID(), blueprint, creditOptIn: false });
    await settle();
    expect(await result(refused.json<{ sequence: number }>().sequence)).toMatchObject({
      code: 'ARTIST_BLOCKED',
    });
  });

  it('limits the OBS bridge to availability signals for its own channel', async () => {
    const issued = await owned(`/api/channels/${channel}/studio/bridge-capability`, {});
    const capability = issued.json<{ capability: string }>().capability;
    const report = (payload: unknown, channelId = channel, token = capability) =>
      app.inject({
        method: 'POST',
        url: `/api/channels/${channelId}/availability`,
        headers: { authorization: `Bearer ${token}` },
        payload: payload as Record<string, unknown>,
      });
    expect((await report({ kind: 'scene', scene: 'Live' }, other)).json()).toMatchObject({
      error: { code: 'BRIDGE_UNAUTHORIZED' },
    });
    expect((await report({ kind: 'approve' })).json()).toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });
    const read = opaqueToken();
    await pool.query(
      'insert into overlay_capabilities(hash,world_id,channel_id) values($1,$2,$3)',
      [sha256Hex(read), worldId, channel],
    );
    // The ordinary read-only overlay credential cannot report availability.
    expect((await report({ kind: 'hidden' }, channel, read)).json()).toMatchObject({
      error: { code: 'BRIDGE_UNAUTHORIZED' },
    });
    // Nor can the bridge reach owner controls.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/${channel}/studio/start`,
          headers: {
            authorization: `Bearer ${capability}`,
            origin: config.origin,
            'idempotency-key': randomUUID(),
          },
          payload: { expectedVersion: await version() },
        })
      ).json(),
    ).toMatchObject({ error: { code: 'SIGN_IN_REQUIRED' } });
    expect((await report({ kind: 'heartbeat', scene: 'BRB' })).statusCode).toBe(202);
    expect((await report({ kind: 'hidden' })).json()).toEqual({ accepted: true });
    await settle();
    const studio = (
      await app.inject({ url: '/api/controller/studio', cookies: ownerCookies })
    ).json<{
      bridge: { stale: boolean; issued: boolean };
    }>();
    expect(studio.bridge).toMatchObject({ stale: true, issued: true });
    const reissued = await owned(`/api/channels/${channel}/studio/bridge-capability`, {});
    expect(reissued.statusCode).toBe(200);
    expect((await report({ kind: 'hidden' })).json()).toMatchObject({
      error: { code: 'BRIDGE_UNAUTHORIZED' },
    });
  });

  it('closes new studios, submissions and bridge links when the installation flag is off', async () => {
    const closed = await buildApp({
      config: { logLevel: 'silent', webRoot: undefined, twitch: { ...config, studio: false } },
      pool,
    });
    try {
      const post = (url: string, payload: Record<string, unknown>) =>
        closed.inject({
          method: 'POST',
          url,
          cookies: ownerCookies,
          headers: {
            origin: config.origin,
            'x-csrf-token': owner.csrf,
            'idempotency-key': randomUUID(),
          },
          payload,
        });
      expect(
        (
          await post(`/api/channels/${channel}/studio/start`, { expectedVersion: await version() })
        ).json(),
      ).toMatchObject({
        error: { code: 'STUDIO_DISABLED' },
      });
      expect(
        (
          await post(`/api/channels/${channel}/studio/settings`, {
            expectedVersion: await version(),
            settings: { ...defaultStudioSettings, enabled: true },
          })
        ).json(),
      ).toMatchObject({ error: { code: 'STUDIO_DISABLED' } });
      expect(
        (await post(`/api/channels/${channel}/studio/bridge-capability`, {})).json(),
      ).toMatchObject({
        error: { code: 'STUDIO_DISABLED' },
      });
    } finally {
      await closed.close();
    }
  });

  it('reviews only an owned studio with its current session version', async () => {
    const session = (
      await pool.query<{ id: string; version: number }>(
        'select id,version from studio_sessions where world_id=$1 and channel_id=$2 order by created_at desc limit 1',
        [worldId, channel],
      )
    ).rows[0]!;
    const review = (sessionId: string) =>
      owned(`/api/studios/${sessionId}/review`, {
        expectedVersion: 0,
        sessionVersion: session.version,
        decision: 'approve',
      });
    expect((await review(randomUUID())).json()).toMatchObject({
      error: { code: 'STUDIO_NOT_FOUND' },
    });
    const wrong = await owned(`/api/studios/${session.id}/review`, {
      expectedVersion: await version(),
      sessionVersion: session.version,
      decision: 'approve',
    });
    await settle();
    expect(await result(wrong.json<{ sequence: number }>().sequence)).toMatchObject({
      code: 'STUDIO_WRONG_PHASE',
    });
    expect(
      (await app.inject({ url: `/api/blueprints/${'0'.repeat(64)}?studio=${session.id}` }))
        .statusCode,
    ).toBe(404);
  });
  it('requires artist CSRF for identity erasure and invalidates the erased session', async () => {
    const url = '/api/artist/forget';
    expect(
      (await app.inject({ method: 'POST', url, cookies: artistCookies, payload: {} })).statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: 'POST',
      url,
      cookies: artistCookies,
      headers: { origin: config.origin, 'x-csrf-token': artist.csrf },
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ forgotten: true, sessionsDeleted: 1 });
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          cookies: artistCookies,
          headers: { origin: config.origin, 'x-csrf-token': artist.csrf },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });
});
