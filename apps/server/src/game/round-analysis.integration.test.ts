import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { roundAnalysisSchema } from '@ripple/contracts';
import { buildApp } from '../app.ts';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { createSyntheticPeer } from './synthetic-peer.ts';
import { canonicalGameProjection } from './replay.ts';
import { readSnapshot } from './snapshot.ts';

describe('scoped saved round-analysis HTTP reads', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool, app: FastifyInstance;
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    app = await buildApp({ pool, config: { logLevel: 'silent', webRoot: undefined } });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await temporary.drop();
  });
  async function send(world: SyntheticWorld, value: unknown) {
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), value);
    await settleSyntheticWorld(pool, world);
  }
  async function advance(world: SyntheticWorld, ms: number) {
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), ms);
  }
  async function observe(world: SyntheticWorld, valid = true) {
    if (valid)
      for (const actorKey of ['private-actor-a', 'private-actor-b', 'private-actor-c'])
        await send(world, { type: 'activity', actorKey });
    await advance(world, 12000);
  }
  async function start(mechanicsVersion: 0 | 1 = 1) {
    const world = await createSyntheticWorld(pool, {
        mechanicsVersion,
        seed: 'private-channel-seed',
      }),
      seed = syntheticSeedCommand();
    await send(world, seed);
    return { world, seed };
  }
  async function get(
    world: SyntheticWorld,
    roundId: string,
    capability = world.readCapability,
    channelId = world.channelId,
  ) {
    return app.inject({
      url: `/api/rounds/${roundId}/explanation?worldId=${world.worldId}&channelId=${channelId}`,
      headers: { authorization: `Bearer ${capability}` },
    });
  }
  it('returns saved actual/ancestor/rejected-choice numbers with no actor identities or gameplay writes', async () => {
    const { world, seed } = await start();
    await send(world, { type: 'vote', actorKey: 'private-winning-voter', choice: 2 });
    await advance(world, 3200);
    await send(world, { type: 'shock', kind: 'category_change' });
    await observe(world);
    const before = await canonicalGameProjection(pool, world),
      response = await get(world, seed.roundId);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const data = roundAnalysisSchema.parse(response.json());
    expect(data).toMatchObject({
      status: 'resolved',
      mechanicsVersion: 1,
      participants: [{ organismId: seed.organismId, actual: { outcome: 'applied' } }],
    });
    const savedAncestor = (
      await pool.query<{ result: unknown }>(
        'select result from ancestor_trials where world_id=$1 and round_id=$2',
        [world.worldId, seed.roundId],
      )
    ).rows[0]!;
    const savedChoice = (
      await pool.query<{ result: unknown; inputs: unknown }>(
        'select result,inputs from choice_replays where world_id=$1 and round_id=$2',
        [world.worldId, seed.roundId],
      )
    ).rows[0]!;
    expect(data.participants[0]!.ancestor!.result).toEqual(savedAncestor.result);
    expect(data.alternative!.result).toEqual(savedChoice.result);
    expect(data.alternative!.inputs).toEqual(savedChoice.inputs);
    expect(data.participants[0]!.actual.score).toEqual(data.alternative!.result.actual);
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))!.payload.round!.analysis,
    ).toEqual(data);
    expect(response.body).not.toMatch(
      /actorKey|private-actor|private-winning-voter|private-channel-seed/,
    );
    expect(response.body).not.toContain(world.ownerCapability);
    expect(response.body).not.toContain(world.readCapability);
    expect((await get(world, seed.roundId)).body).toBe(response.body);
    expect(await canonicalGameProjection(pool, world)).toBe(before);
  });
  it('enforces capability, world/channel scope, revocation and unresolved-state errors', async () => {
    const { world, seed } = await start(),
      other = await start();
    expect(
      (
        await app.inject({
          url: `/api/rounds/${seed.roundId}/explanation?worldId=${world.worldId}&channelId=${world.channelId}`,
        })
      ).statusCode,
    ).toBe(401);
    expect((await get(world, seed.roundId, other.world.readCapability)).statusCode).toBe(401);
    expect((await get(world, other.seed.roundId)).statusCode).toBe(404);
    const pending = await get(world, seed.roundId);
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({ error: { code: 'ROUND_UNRESOLVED' } });
    const peer = await createSyntheticPeer(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      'Other analysis channel',
    );
    expect((await get(world, seed.roundId, peer.readCapability, peer.channelId)).statusCode).toBe(
      404,
    );
    expect((await get(world, seed.roundId, world.readCapability, peer.channelId)).statusCode).toBe(
      401,
    );
    await pool.query(
      'update overlay_capabilities set revoked_at=clock_timestamp() where world_id=$1 and channel_id=$2',
      [world.worldId, world.channelId],
    );
    expect((await get(world, seed.roundId)).statusCode).toBe(401);
  });
  it('distinguishes held limited-data estimates and older rounds without recorded comparisons', async () => {
    const { world, seed } = await start();
    await advance(world, 3200);
    await observe(world, false);
    const limited = roundAnalysisSchema.parse((await get(world, seed.roundId)).json());
    expect(limited.participants[0]).toMatchObject({
      actual: { outcome: 'limited', healthAfter: 70 },
      ancestor: null,
    });
    expect(limited.alternative).toMatchObject({
      confidence: 'limited',
      inputs: { actualOutcome: 'limited', actualHealthAfter: 70 },
    });
    expect(limited.alternative!.result.actual.healthAfter).not.toBe(70);
    const legacy = await start(0);
    await advance(legacy.world, 3200);
    await observe(legacy.world);
    expect(
      roundAnalysisSchema.parse((await get(legacy.world, legacy.seed.roundId)).json()),
    ).toMatchObject({
      mechanicsVersion: 0,
      participants: [{ actual: { outcome: 'applied' }, ancestor: null }],
      alternative: null,
    });
  });
  async function earned() {
    const { world: source } = await start(),
      peer = await createSyntheticPeer(
        pool,
        source,
        source.ownerCapability,
        randomUUID(),
        'Analysis trace host',
      ),
      host = { ...source, channelId: peer.channelId, readCapability: peer.readCapability };
    await send(host, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    const childId = randomUUID();
    await send(source, {
      type: 'raid',
      transferId: randomUUID(),
      childId,
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: host.channelId,
      destinationTwitchId: host.channelId,
    });
    await advance(host, 3200);
    await observe(host);
    await advance(host, 800);
    await advance(host, 3200);
    await observe(host);
    await advance(host, 800);
    const roundId = (await readSnapshot(pool, host.worldId, host.channelId))!.payload.round!.id;
    return { source, host, childId, roundId };
  }
  it('retains immutable trace attribution and saved scores after the active effect is cleared', async () => {
    const { host, source, childId, roundId } = await earned();
    await send(host, { type: 'vote', actorKey: 'private-trace-voter', choice: 1 });
    await advance(host, 3200);
    await observe(host);
    const response = await get(host, roundId),
      data = roundAnalysisSchema.parse(response.json());
    expect(data.traceAttribution).toMatchObject({
      emitterId: childId,
      originChannelId: source.channelId,
      template: 'charged',
    });
    expect(data.participants[0]!.actual.score.trace).toMatchObject({ template: 'charged' });
    await send(host, { type: 'clearTrace' });
    expect((await get(host, roundId)).body).toBe(response.body);
    expect((await get(host, roundId, source.readCapability)).statusCode).toBe(401);
  });
  it('reports explicit cancellation without inventing scores, and fails closed for missing modern comparison records', async () => {
    const { host, roundId } = await earned();
    await send(host, { type: 'clearTrace' });
    expect(roundAnalysisSchema.parse((await get(host, roundId)).json())).toMatchObject({
      status: 'cancelled',
      participants: [],
      alternative: null,
      cancellation: { reason: 'broadcaster-clear' },
    });
    const { world, seed } = await start();
    await advance(world, 3200);
    await observe(world);
    await pool.query('delete from ancestor_trials where world_id=$1 and round_id=$2', [
      world.worldId,
      seed.roundId,
    ]);
    const broken = await get(world, seed.roundId);
    expect(broken.statusCode).toBe(500);
    expect(broken.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });
});
