import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { defaultStudioSettings, founderShell, type StudioChallenge } from '@ripple/contracts';
import { buildApp } from '../app.ts';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { createSyntheticPeer } from './synthetic-peer.ts';
import { exportAcceptedWorld, replayAcceptedWorld } from './world-replay.ts';
import { computeMetrics } from './metrics.ts';

describe('product analytics', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool, app: FastifyInstance;
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    app = await buildApp({ config: { logLevel: 'silent', webRoot: undefined }, pool });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await temporary.drop();
  });
  const send = async (scope: SyntheticWorld, value: unknown) => {
    await acceptSyntheticCommand(pool, scope, scope.ownerCapability, randomUUID(), value);
    await settleSyntheticWorld(pool, scope);
  };
  const advance = (scope: SyntheticWorld, ms: number) =>
    advanceSyntheticClock(pool, scope, scope.ownerCapability, randomUUID(), ms);
  const events = async (worldId: string) =>
    (
      await pool.query<{ type: string; aggregates: Record<string, unknown> }>(
        'select type,aggregates from analytics_events where world_id=$1 order by created_at,type',
        [worldId],
      )
    ).rows;

  it('records anonymous studio and gameplay events in the committing transaction and computes bounded metrics', async () => {
    const source = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(source, syntheticSeedCommand());
    await send(source, { type: 'vote', actorKey: 'a', choice: 1 });
    await send(source, {
      type: 'studioSettings',
      settings: { ...defaultStudioSettings, enabled: true, creationMs: 10_000, votingMs: 10_000 },
    });
    await send(source, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    const session = (
      await pool.query<{ id: string; version: number; challenge: StudioChallenge }>(
        'select id,version,challenge from studio_sessions where world_id=$1',
        [source.worldId],
      )
    ).rows[0]!;
    await send(source, {
      type: 'studioProposal',
      sessionId: session.id,
      proposalId: randomUUID(),
      artistKey: createHash('sha256').update('artist').digest('hex'),
      credit: 'artist',
      creditOptIn: false,
      blueprint: {
        schemaVersion: 1,
        worldId: session.challenge.worldId,
        studioSessionId: session.id,
        baseOrganismId: session.challenge.baseOrganismId,
        baseOrganismVersion: session.challenge.baseOrganismVersion,
        mutationTemplateId: session.challenge.mutationTemplateIds[0],
        rendererVersion: 'shell-v1',
        part: founderShell,
      },
    });
    await advance(source, 10_000);
    await send(source, { type: 'vote', actorKey: 'studio-voter', choice: 1 });
    await advance(source, 10_000);
    const review = (
      await pool.query<{ version: number }>('select version from studio_sessions where id=$1', [
        session.id,
      ])
    ).rows[0]!;
    await send(source, {
      type: 'studioReview',
      sessionId: session.id,
      sessionVersion: review.version,
      decision: 'approve',
      adaptationId: randomUUID(),
    });
    await advance(source, 3_200);
    const host = {
      ...source,
      channelId: (
        await createSyntheticPeer(pool, source, source.ownerCapability, randomUUID(), 'Host')
      ).channelId,
    };
    await send(host, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    await send(source, {
      type: 'raid',
      transferId: randomUUID(),
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: host.channelId,
      destinationTwitchId: host.channelId,
    });
    const recorded = await events(source.worldId);
    const types = new Set(recorded.map((event) => event.type));
    for (const type of [
      'strain_seeded',
      'ballot_opened',
      'vote_accepted',
      'studio_triggered',
      'studio_opened',
      'proposal_submitted',
      'shortlist_published',
      'studio_vote_accepted',
      'proposal_approved',
      'adaptation_hatched',
      'raid_received',
      'child_admitted',
      'inherited_blueprint_seen',
    ])
      expect(types).toContain(type);
    // Every server event is tagged synthetic and carries no identities or text.
    expect(recorded.every((event) => event.aggregates.sandbox === true)).toBe(true);
    expect(JSON.stringify(recorded)).not.toContain('studio-voter');
    expect(JSON.stringify(recorded)).not.toContain('artist');

    const metrics = await computeMetrics(pool, source.worldId, null, 'sandbox');
    const byName = Object.fromEntries(metrics.metrics.map((item) => [item.name, item]));
    expect(byName['Hatch success']).toMatchObject({ numerator: 1, denominator: 1, ratio: 1 });
    expect(byName['Arrival reliability']).toMatchObject({ numerator: 1, denominator: 1 });
    expect(byName['Trace engagement']?.ratio).toBeNull();
    // Live metrics for the same world see none of the synthetic activity.
    expect((await computeMetrics(pool, source.worldId, null, 'live')).counts).toEqual({});

    // Replaying the world reconstructs history without counting it as new activity.
    const before = (await events(source.worldId)).length;
    const replay = await replayAcceptedWorld(pool, await exportAcceptedWorld(pool, source.worldId));
    expect(await events(replay.worldId)).toEqual([]);
    expect((await events(source.worldId)).length).toBe(before);
  });

  it('accepts only allow-listed client events for an existing non-replay scope', async () => {
    const scope = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    const post = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/analytics',
        payload: payload as Record<string, unknown>,
      });
    expect(
      (
        await post({
          event: 'overlay_seen',
          scope: { kind: 'channel', worldId: scope.worldId, channelId: scope.channelId },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await post({
          event: 'vote_accepted',
          scope: { kind: 'channel', worldId: scope.worldId, channelId: scope.channelId },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post({
          event: 'camera_enabled',
          scope: { kind: 'channel', worldId: scope.worldId, channelId: scope.channelId },
          landmarks: [[0.1, 0.2]],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post({ event: 'editor_opened', scope: { kind: 'studio', sessionId: randomUUID() } }))
        .statusCode,
    ).toBe(204);
    const stored = await events(scope.worldId);
    // A sandbox overlay connection is not live onboarding.
    expect(stored).toEqual([{ type: 'overlay_seen', aggregates: { client: true, sandbox: true } }]);
  });
});
