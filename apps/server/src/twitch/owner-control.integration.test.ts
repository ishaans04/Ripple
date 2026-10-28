import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import type { GameCommand } from '@ripple/contracts';
import { buildApp } from '../app.ts';
import { processNextInput } from '../game/worker.ts';
import { syntheticSeedCommand } from '../game/sandbox.ts';
import { ensureInstallation, enrollChannel } from './installation.ts';
import { storeGrant } from './grants.ts';
import { opaqueToken, privateHash, type TwitchConfig } from './security.ts';

describe('owner preparation and admission controls', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool, app: FastifyInstance;
  let worldId: string, source: string, target: string;
  const config: TwitchConfig = {
    origin: 'https://ripple.example',
    clientId: 'control-test',
    clientSecret: 'secret',
    webhookSecret: 's'.repeat(64),
    encryptionKey: randomBytes(32).toString('base64'),
    actorKey: randomBytes(32).toString('base64'),
    sessionSecret: randomBytes(32).toString('base64'),
    operatorSecret: 'o'.repeat(40),
  };
  const session = opaqueToken(),
    csrf = opaqueToken();
  const cookies = { '__Host-ripple-session': session, '__Host-ripple-csrf': csrf };
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    worldId = await ensureInstallation(pool, config);
    [source, target] = await transaction(pool, async (client) => {
      const a = await enrollChannel(client, worldId, '123', 'source');
      const b = await enrollChannel(client, worldId, '456', 'target');
      for (const [subject, channelId] of [
        ['123', a],
        ['456', b],
        ['999', null],
      ] as const) {
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
      }
      await client.query(
        "insert into controller_sessions(hash,world_id,channel_id,subject,csrf_hash,expires_at) values($1,$2,$3,'456',$4,clock_timestamp()+interval '1 hour')",
        [
          privateHash(config.sessionSecret, 'session', session),
          worldId,
          b,
          privateHash(config.sessionSecret, 'csrf', csrf),
        ],
      );
      return [a, b];
    });
    for (const channel of [source, target]) {
      await send(channel, { type: 'integration', online: true, healthy: true });
      await send(channel, syntheticSeedCommand());
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
    while (await processNextInput(pool, worldId, channelId));
  }
  async function version() {
    return (
      await pool.query<{ state_version: number }>(
        'select state_version from channels where world_id=$1 and id=$2',
        [worldId, target],
      )
    ).rows[0]!.state_version;
  }
  async function post(payload: Record<string, unknown>, key = randomUUID(), channel = target) {
    return await app.inject({
      method: 'POST',
      url: `/api/channels/${channel}/control`,
      cookies,
      headers: { origin: config.origin, 'x-csrf-token': csrf, 'idempotency-key': key },
      payload,
    });
  }
  it('requires owner CSRF and exact bodies, coalesces preparation, and fences queued version races', async () => {
    const payload = { action: 'prepare', expectedVersion: await version() },
      key = randomUUID();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/${target}/control`,
          cookies,
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect((await post(payload, key, source)).statusCode).toBe(403);
    expect(
      (await post({ ...payload, eligibility: { authorized: true, rulesCompatible: true } }))
        .statusCode,
    ).toBe(400);
    const first = await post(payload, key);
    expect(first.statusCode).toBe(202);
    const duplicate = await post(payload, key);
    expect(duplicate.json<{ sequence: number }>().sequence).toBe(
      first.json<{ sequence: number }>().sequence,
    );
    expect(
      (
        await post(
          { ...payload, action: 'blockSource', sourceChannelId: source, blocked: true },
          key,
        )
      ).statusCode,
    ).toBe(409);
    const staleKey = randomUUID();
    expect((await post(payload, staleKey)).statusCode).toBe(202);
    while (await processNextInput(pool, worldId, target));
    const stale = await app.inject({ url: `/api/controller/commands/${staleKey}`, cookies });
    expect(stale.json<{ result: { code: string } }>().result.code).toBe('STALE_VERSION');
    expect(
      (
        await pool.query<{ preparation_requested: boolean }>(
          'select preparation_requested from channel_play where world_id=$1 and channel_id=$2',
          [worldId, target],
        )
      ).rows[0]?.preparation_requested,
    ).toBe(true);
    // A retry remains the original receipt even after the channel version advances.
    expect((await post(payload, key)).json<{ duplicate: boolean }>().duplicate).toBe(true);
  });
  it('requires a destination-owned transfer and current version, then durably accepts or refuses it', async () => {
    const transferId = randomUUID();
    await send(source, {
      type: 'raid',
      transferId,
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: target,
      destinationTwitchId: '456',
    });
    while (await processNextInput(pool, worldId, target));
    const transfer = async () =>
      (
        await pool.query<{ version: number; outcome: string }>(
          'select version,outcome from transfers where world_id=$1 and id=$2',
          [worldId, transferId],
        )
      ).rows[0]!;
    expect((await transfer()).outcome).toBe('PENDING_APPROVAL');
    const body = {
      action: 'admission',
      expectedVersion: await version(),
      transferId,
      transferVersion: (await transfer()).version,
      decision: 'accept',
    };
    expect((await post({ ...body, transferId: randomUUID() })).statusCode).toBe(404);
    expect((await post({ ...body, transferVersion: 0 })).statusCode).toBe(409);
    const key = randomUUID();
    expect((await post(body, key)).statusCode).toBe(202);
    expect((await transfer()).outcome).toBe('PENDING_APPROVAL');
    while (await processNextInput(pool, worldId, target));
    expect((await transfer()).outcome).toBe('ACTIVE');
    expect((await post(body, key)).json<{ duplicate: boolean }>().duplicate).toBe(true);
    expect(
      (
        await post({
          ...body,
          expectedVersion: await version(),
          transferVersion: (await transfer()).version,
          decision: 'decline',
        })
      ).statusCode,
    ).toBe(202);
    while (await processNextInput(pool, worldId, target));
    expect((await transfer()).outcome).toBe('DECLINED');
    const child = await pool.query<{ status: string }>(
      'select o.status from organisms o join transfers t on t.world_id=o.world_id and t.child_id=o.id where t.world_id=$1 and t.id=$2',
      [worldId, transferId],
    );
    expect(child.rows[0]?.status).toBe('ARCHIVED');
  });
});
