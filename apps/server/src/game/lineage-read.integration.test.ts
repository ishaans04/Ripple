import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { lineagePageSchema } from '@ripple/contracts';
import { buildApp } from '../app.ts';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { createSyntheticPeer } from './synthetic-peer.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { canonicalGameProjection } from './replay.ts';

describe('capability-scoped lineage ancestry reads', () => {
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
  async function observe(world: SyntheticWorld) {
    for (const actorKey of ['private-a', 'private-b', 'private-c'])
      await send(world, { type: 'activity', actorKey });
    await advance(world, 12000);
  }
  async function start() {
    const world = await createSyntheticWorld(pool, {
        mechanicsVersion: 1,
        seed: 'private-lineage-seed',
      }),
      seed = syntheticSeedCommand();
    await send(world, { ...seed, name: 'Approved origin strain' });
    return { world, seed };
  }
  async function peer(world: SyntheticWorld, label = 'Approved host') {
    const target = await createSyntheticPeer(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      label,
    );
    return { ...world, channelId: target.channelId, readCapability: target.readCapability };
  }
  async function raid(source: SyntheticWorld, host: SyntheticWorld) {
    const command = {
      type: 'raid',
      transferId: randomUUID(),
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: host.channelId,
      destinationTwitchId: host.channelId,
    };
    await send(source, command);
    return command;
  }
  function get(
    world: SyntheticWorld,
    lineageId: string,
    query = '',
    capability = world.readCapability,
  ) {
    return app.inject({
      url: `/api/lineages/${lineageId}?worldId=${world.worldId}&channelId=${world.channelId}${query}`,
      headers: { authorization: `Bearer ${capability}` },
    });
  }
  it('paginates actual retained branches without voter identities, private snapshots or gameplay writes', async () => {
    const { world, seed } = await start();
    const transfers = [];
    for (let i = 0; i < 4; i++)
      transfers.push(await raid(world, await peer(world, `Held host ${i}`)));
    const before = await canonicalGameProjection(pool, world),
      pages = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const response = await get(
        world,
        seed.lineageId,
        `&limit=2${cursor === null ? '' : `&after=${encodeURIComponent(cursor)}`}`,
      );
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const data = lineagePageSchema.parse(response.json());
      expect(data).toMatchObject({
        mode: 'sandbox',
        worldId: world.worldId,
        lineageId: seed.lineageId,
        origin: { channelId: world.channelId },
        counts: { total: 5, alive: 1, harbor: 4, fossil: 0, archived: 0 },
      });
      expect(response.body).not.toMatch(
        /private-lineage-seed|private-a|actorKey|destination_twitch_id|ownerCapability|receiptId|captureSequence/,
      );
      expect(response.body).not.toContain(world.ownerCapability);
      expect(response.body).not.toContain(world.readCapability);
      pages.push(...data.nodes);
      cursor = data.next;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(pages).toHaveLength(5);
    expect(new Set(pages.map((node) => node.id)).size).toBe(5);
    expect(pages[0]).toMatchObject({
      id: seed.organismId,
      generation: 0,
      parentId: null,
      name: 'Approved origin strain',
      birth: null,
      lastHost: { channelId: world.channelId, role: 'resident', endedAt: null },
    });
    for (const transfer of transfers)
      expect(pages.find((node) => node.id === transfer.childId)).toMatchObject({
        parentId: seed.organismId,
        founderId: seed.organismId,
        generation: 1,
        status: 'HARBOR',
        lastHost: { channelId: transfer.destinationChannelId, role: 'harbor', endedAt: null },
        birth: {
          transferId: transfer.transferId,
          source: { channelId: world.channelId },
          destination: { channelId: transfer.destinationChannelId },
          outcome: 'PENDING_APPROVAL',
        },
      });
    expect(await canonicalGameProjection(pool, world)).toBe(before);
  });
  it('requires authority and a lineage encounter, including pending arrivals, and respects revocation/world expiry', async () => {
    const { world, seed } = await start(),
      unrelated = await peer(world),
      other = await start(),
      rival = syntheticSeedCommand();
    await send(unrelated, rival);
    expect((await get(unrelated, seed.lineageId)).statusCode).toBe(404);
    expect((await get(world, rival.lineageId)).statusCode).toBe(404);
    expect((await get(world, other.seed.lineageId)).statusCode).toBe(404);
    expect((await get(other.world, seed.lineageId)).statusCode).toBe(404);
    expect((await get(world, seed.lineageId, '', unrelated.readCapability)).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: `/api/lineages/${seed.lineageId}?worldId=${world.worldId}&channelId=${world.channelId}`,
        })
      ).statusCode,
    ).toBe(401);
    await raid(world, unrelated);
    expect((await get(unrelated, seed.lineageId)).statusCode).toBe(200);
    expect((await get(world, rival.lineageId)).statusCode).toBe(404);
    await pool.query(
      'update overlay_capabilities set revoked_at=clock_timestamp() where world_id=$1 and channel_id=$2',
      [world.worldId, world.channelId],
    );
    expect((await get(world, seed.lineageId)).statusCode).toBe(401);
    expect((await get(unrelated, seed.lineageId)).statusCode).toBe(200);
    await pool.query(
      "update worlds set expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [world.worldId],
    );
    expect((await get(unrelated, seed.lineageId)).statusCode).toBe(401);
  });
  it('rejects malformed cursors, unbounded pages and extra query fields before reading', async () => {
    const { world, seed } = await start();
    for (const query of [
      '&limit=0',
      '&limit=51',
      '&after=NaN:bad',
      '&after=:11111111-1111-4111-8111-111111111111',
      '&extra=secret',
    ])
      expect((await get(world, seed.lineageId, query)).statusCode).toBe(400);
    expect(
      lineagePageSchema.parse(
        (await get(world, seed.lineageId, `&after=16:${randomUUID()}`)).json(),
      ),
    ).toMatchObject({ nodes: [], next: null, counts: { total: 1 } });
  });
  it('preserves the actual fossil appearance and last ended host after an incumbent tie', async () => {
    const { world, seed } = await start(),
      host = await peer(world);
    await send(host, syntheticSeedCommand());
    await send(host, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 1 });
    const arrival = await raid(world, host);
    await advance(host, 3200);
    await observe(host);
    await advance(host, 800);
    await advance(host, 3200);
    await observe(host);
    const page = lineagePageSchema.parse((await get(world, seed.lineageId)).json()),
      child = page.nodes.find((node) => node.id === arrival.childId);
    expect(page.counts).toMatchObject({ total: 2, alive: 1, fossil: 1 });
    expect(child).toMatchObject({
      status: 'FOSSIL',
      health: 30,
      appearance: { kind: 'founder', rendererVersion: 'shell-v1' },
      lastHost: { channelId: host.channelId, role: 'visitor' },
      emittedTraces: 0,
      latestTrace: null,
    });
    expect(child!.lastHost!.endedAt).not.toBeNull();
    const saved = (
      await pool.query<{ appearance: unknown; health: number }>(
        'select appearance,health from organisms where world_id=$1 and id=$2',
        [world.worldId, arrival.childId],
      )
    ).rows[0]!;
    expect(child!.appearance).toEqual(saved.appearance);
    expect(child!.health).toBe(saved.health);
    expect((await get(host, seed.lineageId)).statusCode).toBe(200);
  });
  it('keeps earned lineage/host trace attribution after expiry without exposing any other lineage', async () => {
    const { world, seed } = await start(),
      host = await peer(world);
    await send(host, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    const arrival = await raid(world, host);
    for (let i = 0; i < 2; i++) {
      await advance(host, 3200);
      await observe(host);
      await advance(host, 800);
    }
    await send(host, { type: 'vote', actorKey: 'private-keep', choice: 1 });
    await advance(host, 3200);
    await observe(host);
    for (let i = 0; i < 2; i++) {
      await advance(host, 800);
      await advance(host, 3200);
      await observe(host);
    }
    const page = lineagePageSchema.parse((await get(world, seed.lineageId)).json());
    expect(page.nodes.find((node) => node.id === arrival.childId)).toMatchObject({
      emittedTraces: 1,
      latestTrace: {
        template: 'charged',
        status: 'expired',
        remainingRounds: 0,
        host: { channelId: host.channelId, label: 'Synthetic Approved host' },
      },
    });
    expect(page.nodes.find((node) => node.id === seed.organismId)).toMatchObject({
      emittedTraces: 0,
      latestTrace: null,
    });
  }, 20000);
  it('shows an unclaimed branch to its source without revealing an unenrolled destination identity', async () => {
    const { world, seed } = await start(),
      unrelated = await peer(world);
    const childId = randomUUID();
    await send(world, {
      type: 'raid',
      transferId: randomUUID(),
      childId,
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: null,
      destinationTwitchId: 'unapproved-receiver-identity',
      retainUnenrolled: true,
    });
    const response = await get(world, seed.lineageId),
      page = lineagePageSchema.parse(response.json());
    expect(page.nodes.find((node) => node.id === childId)).toMatchObject({
      status: 'HARBOR',
      lastHost: null,
      birth: { destination: null, outcome: 'NOT_ENROLLED', historical: false },
    });
    expect(response.body).not.toContain('unapproved-receiver-identity');
    expect((await get(unrelated, seed.lineageId)).statusCode).toBe(404);
  });
});
