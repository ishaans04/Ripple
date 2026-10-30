import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { passportSchema } from '@ripple/contracts';
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

describe('capability-scoped organism passports', () => {
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
  async function vote(world: SyntheticWorld, counts: readonly number[]) {
    for (const [index, count] of counts.entries())
      for (let i = 0; i < count; i++)
        await send(world, { type: 'vote', actorKey: `voter-${index}-${i}`, choice: index + 1 });
  }
  /** Close the open ballot, observe a confident round and open the next ballot. */
  async function round(world: SyntheticWorld, counts: readonly number[]) {
    await vote(world, counts);
    await advance(world, 3200);
    for (const actorKey of ['private-a', 'private-b', 'private-c'])
      await send(world, { type: 'activity', actorKey });
    await advance(world, 12000);
    await advance(world, 800);
  }
  async function start() {
    const world = await createSyntheticWorld(pool, { mechanicsVersion: 1, seed: 'private-seed' }),
      seed = syntheticSeedCommand();
    await send(world, { ...seed, name: 'Passport strain' });
    return { world, seed };
  }
  async function peer(world: SyntheticWorld, label: string) {
    const target = await createSyntheticPeer(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      label,
    );
    return { ...world, channelId: target.channelId, readCapability: target.readCapability };
  }
  function get(world: SyntheticWorld, organismId: string, query = '', capability?: string) {
    return app.inject({
      url: `/api/organisms/${organismId}/passport?worldId=${world.worldId}&channelId=${world.channelId}${query}`,
      headers: { authorization: `Bearer ${capability ?? world.readCapability}` },
    });
  }
  async function cards(world: SyntheticWorld, roundNumber: number) {
    return (
      await pool.query<{ checkpoint: { candidates: { effect: string; genome: unknown }[] } }>(
        'select checkpoint from rounds where world_id=$1 and channel_id=$2 and number=$3',
        [world.worldId, world.channelId, roundNumber],
      )
    ).rows[0]!.checkpoint.candidates;
  }

  it('records selections, explicit holds, dormant captures and ancestor trials from saved rows only', async () => {
    const { world, seed } = await start();
    await round(world, [3, 2, 0]);
    await round(world, []);
    const before = await canonicalGameProjection(pool, world),
      response = await get(world, seed.organismId),
      passport = passportSchema.parse(response.json()),
      first = await cards(world, 1),
      saved = (
        await pool.query<{ pulse: number; calm: number; grit: number; drift: number }>(
          'select pulse,calm,grit,drift from organisms where world_id=$1 and id=$2',
          [world.worldId, seed.organismId],
        )
      ).rows[0]!;
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(passport).toMatchObject({
      mode: 'sandbox',
      worldId: world.worldId,
      organism: { id: seed.organismId, name: 'Passport strain', generation: 0, genome: saved },
      origin: { channelId: world.channelId },
      parent: null,
      founder: { id: seed.organismId },
      birth: null,
      hosts: [{ channelId: world.channelId }],
      residencies: [{ channelId: world.channelId, role: 'resident', endedAt: null }],
      adaptations: { total: 2, next: null },
    });
    const [latest, earlier] = passport.adaptations.items;
    expect(latest).toMatchObject({ number: 2, selection: { status: 'hold' }, genomeBefore: saved });
    expect(earlier).toMatchObject({
      number: 1,
      host: { channelId: world.channelId },
      selection: {
        status: 'selected',
        effect: first[0]!.effect,
        source: 'generated',
        genomeAfter: saved,
      },
    });
    expect(passport.dormant).toMatchObject({
      total: 1,
      items: [
        {
          supporters: 2,
          totalVotes: 5,
          status: 'active',
          origin: { channelId: world.channelId },
          inherited: false,
          outcome: null,
        },
      ],
    });
    const trials = (
      await pool.query<{ round_id: string; result: { fitnessDifference: number } }>(
        'select round_id,result from ancestor_trials where world_id=$1 and organism_id=$2',
        [world.worldId, seed.organismId],
      )
    ).rows;
    expect(trials.length).toBeGreaterThan(0);
    expect(passport.ancestorTrials.total).toBe(trials.length);
    for (const trial of trials)
      expect(
        passport.ancestorTrials.items.find((item) => item.roundId === trial.round_id),
      ).toMatchObject({ fitnessDifference: trial.result.fitnessDifference });
    expect(passport.traces).toEqual({ total: 0, items: [] });
    expect(response.body).not.toMatch(
      /voter-|private-|actorKey|captureProfile|captureSequence|ownerCapability|receiptId/,
    );
    const older = passportSchema.parse((await get(world, seed.organismId, '&before=2')).json());
    expect(older.adaptations.items.map((item) => item.number)).toEqual([1]);
    expect(older.adaptations.next).toBeNull();
    expect(await canonicalGameProjection(pool, world)).toBe(before);
  });

  it('shows a raid child its parent, birth, admitted hosts and residency timeline', async () => {
    const { world, seed } = await start(),
      host = await peer(world, 'Passport host');
    await send(host, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    const childId = randomUUID(),
      transferId = randomUUID();
    await send(world, {
      type: 'raid',
      transferId,
      childId,
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: host.channelId,
      destinationTwitchId: host.channelId,
    });
    await advance(host, 3200);
    const fromHost = passportSchema.parse((await get(host, childId)).json()),
      fromSource = passportSchema.parse((await get(world, childId)).json());
    expect(fromHost).toEqual(fromSource);
    expect(fromHost).toMatchObject({
      organism: { id: childId, generation: 1, appearanceMapping: 1 },
      parent: { id: seed.organismId, name: 'Passport strain', status: 'ALIVE' },
      founder: { id: seed.organismId },
      birth: {
        transferId,
        source: { channelId: world.channelId },
        destination: { channelId: host.channelId, label: 'Synthetic Passport host' },
        historical: false,
      },
      hosts: [{ channelId: world.channelId }, { channelId: host.channelId }],
      adaptations: { total: 0, items: [], next: null },
    });
    expect(fromHost.organism.marks.ancestry).toEqual([
      { channelId: host.channelId, label: 'Synthetic Passport host' },
    ]);
    expect(fromHost.residencies.map((item) => item.channelId)).toEqual(
      fromHost.residencies.map(() => host.channelId),
    );
    // The host had no resident, so the admitted arrival became its resident.
    expect(fromHost.residencies.at(-1)).toMatchObject({ role: 'resident', endedAt: null });
  });

  it('requires read authority and a lineage encounter, and rejects malformed requests', async () => {
    const { world, seed } = await start(),
      unrelated = await peer(world, 'Unrelated'),
      other = await start();
    expect((await get(unrelated, seed.organismId)).statusCode).toBe(404);
    expect((await get(other.world, seed.organismId)).statusCode).toBe(404);
    expect((await get(world, other.seed.organismId)).statusCode).toBe(404);
    expect((await get(world, randomUUID())).statusCode).toBe(404);
    expect((await get(world, seed.organismId, '', unrelated.readCapability)).statusCode).toBe(401);
    for (const query of ['&before=0', '&before=-1', '&before=x', '&extra=1'])
      expect((await get(world, seed.organismId, query)).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          url: `/api/organisms/not-a-uuid/passport?worldId=${world.worldId}&channelId=${world.channelId}`,
          headers: { authorization: `Bearer ${world.readCapability}` },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      passportSchema.parse((await get(world, seed.organismId.toUpperCase())).json()).organism.id,
    ).toBe(seed.organismId);
    await pool.query(
      'update overlay_capabilities set revoked_at=clock_timestamp() where world_id=$1 and channel_id=$2',
      [world.worldId, world.channelId],
    );
    expect((await get(world, seed.organismId)).statusCode).toBe(401);
  });
});
