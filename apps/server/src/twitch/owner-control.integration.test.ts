import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { controllerStatusSchema, type GameCommand } from '@ripple/contracts';
import { buildApp } from '../app.ts';
import { processNextInput } from '../game/worker.ts';
import { syntheticSeedCommand } from '../game/sandbox.ts';
import { readSnapshot } from '../game/snapshot.ts';
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
  async function post(
    payload: Record<string, unknown>,
    key: string = randomUUID(),
    channel = target,
    remoteAddress = '127.0.0.1',
  ) {
    return await app.inject({
      remoteAddress,
      method: 'POST',
      url: `/api/channels/${channel}/control`,
      cookies,
      headers: { origin: config.origin, 'x-csrf-token': csrf, 'idempotency-key': key },
      payload,
    });
  }
  it('records scoped trace settings with owner CSRF, strict fields, versions and retry-stable receipts', async () => {
    // This independent client has its own real route budget; production limits stay unchanged.
    const tracePost = (payload: Record<string, unknown>, key?: string, channel?: string) =>
      post(payload, key, channel, '127.0.0.2');
    const body = { action: 'setTraces', enabled: false, expectedVersion: await version() },
      key = randomUUID();
    expect((await tracePost(body, key, source)).statusCode).toBe(403);
    expect((await tracePost({ ...body, template: 'shelter' })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/${target}/control`,
          cookies,
          payload: body,
          remoteAddress: '127.0.0.2',
        })
      ).statusCode,
    ).toBe(403);
    const accepted = await tracePost(body, key);
    expect(accepted.statusCode).toBe(202);
    expect((await tracePost(body, key)).json<{ sequence: number }>().sequence).toBe(
      accepted.json<{ sequence: number }>().sequence,
    );
    while (await processNextInput(pool, worldId, target));
    expect(
      (
        await pool.query(
          'select traces_enabled from channel_play where world_id=$1 and channel_id=$2',
          [worldId, target],
        )
      ).rows[0],
    ).toEqual({ traces_enabled: false });
    const committed = await app.inject({ url: `/api/controller/commands/${key}`, cookies });
    expect(committed.json<{ result: { code: string } }>().result.code).toBe('APPLIED');
    expect((await tracePost(body, key)).json<{ duplicate: boolean }>().duplicate).toBe(true);
    expect((await tracePost({ ...body, enabled: true })).statusCode).toBe(409);
    await send(target, { type: 'setTraces', enabled: true });
    expect(
      (await tracePost({ action: 'clearTrace', expectedVersion: await version() })).statusCode,
    ).toBe(202);
    while (await processNextInput(pool, worldId, target));
  });
  it('records broadcaster display preferences through versioned owner controls without changing game state', async () => {
    const displayPost = (payload: Record<string, unknown>, key?: string, channel?: string) =>
      post(payload, key, channel, '127.0.0.3');
    const before = await readSnapshot(pool, worldId, target),
      preferences = { layout: 'expanded', reducedMotion: true, familyNews: false },
      body = { action: 'display', preferences, expectedVersion: await version() },
      key = randomUUID();
    expect(before?.payload.display).toEqual({
      layout: 'compact',
      reducedMotion: false,
      familyNews: true,
    });
    expect((await displayPost(body, key, source)).statusCode).toBe(403);
    for (const invalid of [
      { ...body, preferences: { ...preferences, layout: 'huge' } },
      { ...body, preferences: { ...preferences, sound: true } },
      { ...body, preferences: { layout: 'expanded' } },
    ])
      expect((await displayPost(invalid)).statusCode).toBe(400);
    expect((await displayPost(body, key)).statusCode).toBe(202);
    expect((await displayPost(body, key)).json<{ duplicate: boolean }>().duplicate).toBe(true);
    while (await processNextInput(pool, worldId, target));
    const after = await readSnapshot(pool, worldId, target);
    expect(after?.payload.display).toEqual(preferences);
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(after?.payload.organism).toEqual(before?.payload.organism);
    expect(after?.payload.round).toEqual(before?.payload.round);
    expect((await displayPost({ ...body, preferences: defaults() })).statusCode).toBe(409);
    const same = randomUUID();
    expect(
      (await displayPost({ ...body, expectedVersion: await version() }, same)).statusCode,
    ).toBe(202);
    while (await processNextInput(pool, worldId, target));
    const unchanged = await app.inject({ url: `/api/controller/commands/${same}`, cookies });
    expect(unchanged.json<{ result: { code: string } }>().result.code).toBe('NO_CHANGE');
    await expect(
      pool.query(
        `update channel_play set display='{"layout":"compact"}' where world_id=$1 and channel_id=$2`,
        [worldId, target],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  function defaults() {
    return { layout: 'compact', reducedMotion: false, familyNews: true };
  }
  it('requires an owner, CSRF and exact versioned bodies for mechanics requests, with retry-stable acceptance', async () => {
    const body = { action: 'enableMechanics', expectedVersion: await version() },
      key = randomUUID();
    const enablePost = (payload: Record<string, unknown>, receipt?: string, channel?: string) =>
      post(payload, receipt, channel, '127.0.0.3');
    expect((await enablePost(body, key, source)).statusCode).toBe(403);
    expect((await enablePost({ ...body, mechanicsVersion: 1 })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/${target}/control`,
          cookies,
          payload: body,
          remoteAddress: '127.0.0.3',
        })
      ).statusCode,
    ).toBe(403);
    const accepted = await enablePost(body, key);
    expect(accepted.statusCode).toBe(202);
    expect((await enablePost(body, key)).json<{ sequence: number }>().sequence).toBe(
      accepted.json<{ sequence: number }>().sequence,
    );
    while (await processNextInput(pool, worldId, target));
    expect(
      (await app.inject({ url: `/api/controller/commands/${key}`, cookies })).json<{
        result: { code: string };
      }>().result.code,
    ).toBe('NO_CHANGE');
    expect((await enablePost(body, key)).json<{ duplicate: boolean }>().duplicate).toBe(true);
    expect((await enablePost({ ...body, expectedVersion: (await version()) - 1 })).statusCode).toBe(
      409,
    );
  });
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
  it('lists and removes only the owner channel blocks, with world-scoped lineage validation', async () => {
    expect((await app.inject({ url: '/api/controller/blocks?kind=source' })).statusCode).toBe(401);
    const lineageId = (
      await pool.query<{ lineage_id: string }>(
        "select o.lineage_id from organisms o join residencies r on r.world_id=o.world_id and r.organism_id=o.id where r.world_id=$1 and r.channel_id=$2 and r.role='resident'",
        [worldId, source],
      )
    ).rows[0]!.lineage_id;
    expect(
      (
        await post({
          action: 'blockLineage',
          lineageId: randomUUID(),
          blocked: true,
          expectedVersion: await version(),
        })
      ).statusCode,
    ).toBe(404);
    for (const body of [
      { action: 'blockSource', sourceChannelId: source },
      { action: 'blockLineage', lineageId },
    ]) {
      expect(
        (await post({ ...body, blocked: true, expectedVersion: await version() })).statusCode,
      ).toBe(202);
      while (await processNextInput(pool, worldId, target));
    }
    for (const [kind, id] of [
      ['source', source],
      ['lineage', lineageId],
    ]) {
      const page = await app.inject({ url: `/api/controller/blocks?kind=${kind}`, cookies });
      expect(page.json()).toEqual({ kind, items: [{ id, label: 'source' }], next: null });
    }
    expect(
      (await app.inject({ url: '/api/controller/blocks?kind=source&after=invalid', cookies }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          action: 'blockLineage',
          lineageId,
          blocked: false,
          expectedVersion: await version(),
        })
      ).statusCode,
    ).toBe(202);
    while (await processNextInput(pool, worldId, target));
    expect(
      (await app.inject({ url: '/api/controller/blocks?kind=lineage', cookies })).json(),
    ).toEqual({ kind: 'lineage', items: [], next: null });
    expect(
      (
        await pool.query('select 1 from source_blocks where world_id=$1 and channel_id=$2', [
          worldId,
          source,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('binds historical adoption to the original Twitch destination and keeps queued acceptance distinct from activation', async () => {
    const historicalSource = await transaction(pool, async (client) => {
      const channelId = await enrollChannel(client, worldId, '777', 'historical source');
      await storeGrant(
        client,
        config,
        worldId,
        channelId,
        'broadcaster',
        { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 },
        { client_id: config.clientId, user_id: '777', scopes: ['channel:bot'], expires_in: 3600 },
      );
      return channelId;
    });
    await send(historicalSource, { type: 'integration', online: true, healthy: true });
    await send(historicalSource, syntheticSeedCommand());
    const transferId = randomUUID();
    await send(historicalSource, {
      type: 'raid',
      transferId,
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: null,
      destinationTwitchId: '456',
      retainUnenrolled: true,
    });
    const status = controllerStatusSchema.parse(
      (await app.inject({ url: `/api/controller/status?claim=${transferId}`, cookies })).json(),
    );
    expect(status.historicalOffers).toHaveLength(1);
    const body = {
        action: 'claimRaid',
        expectedVersion: await version(),
        transferId,
        transferVersion: 0,
      },
      key = randomUUID();
    expect((await post({ ...body, claimantTwitchId: '456' })).statusCode).toBe(400);
    expect((await post({ ...body, transferVersion: 1 })).statusCode).toBe(409);
    expect((await post(body, key, source)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/channels/${target}/control`,
          cookies,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect((await post(body, key)).statusCode).toBe(202);
    expect(
      (
        await pool.query('select outcome from transfers where world_id=$1 and id=$2', [
          worldId,
          transferId,
        ])
      ).rows,
    ).toEqual([{ outcome: 'NOT_ENROLLED' }]);
    expect((await post(body, key)).json<{ duplicate: boolean }>().duplicate).toBe(true);
    while (await processNextInput(pool, worldId, target));
    const adopted = controllerStatusSchema.parse(
      (await app.inject({ url: '/api/controller/status', cookies })).json(),
    );
    expect(adopted.historicalOffers).toEqual([]);
    expect(
      adopted.snapshot?.payload.propagation?.admissions.find((t) => t.id === transferId),
    ).toMatchObject({ outcome: 'ACTIVE', historical: true });
    expect((await post(body, key)).json<{ duplicate: boolean }>().duplicate).toBe(true);
    const unrelated = randomUUID();
    await send(historicalSource, {
      type: 'raid',
      transferId: unrelated,
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: null,
      destinationTwitchId: '888',
      retainUnenrolled: true,
    });
    expect(
      (await post({ ...body, expectedVersion: await version(), transferId: unrelated })).statusCode,
    ).toBe(404);
  });
});
