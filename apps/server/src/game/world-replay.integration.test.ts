import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { defaultStudioSettings, founderShell, type StudioChallenge } from '@ripple/contracts';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { createSyntheticPeer } from './synthetic-peer.ts';
import { ReplayIntegrityError } from './replay.ts';
import {
  compareWorldReplay,
  exportAcceptedWorld,
  replayAcceptedWorld,
  type WorldReplay,
} from './world-replay.ts';

describe('dependency-ordered world replay', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
    await temporary.drop();
  });
  const send = async (scope: SyntheticWorld, value: unknown) => {
    await acceptSyntheticCommand(pool, scope, scope.ownerCapability, randomUUID(), value);
    await settleSyntheticWorld(pool, scope);
  };
  const advance = (scope: SyntheticWorld, ms: number) =>
    advanceSyntheticClock(pool, scope, scope.ownerCapability, randomUUID(), ms);
  const raid = (destination: string) => ({
    type: 'raid',
    transferId: randomUUID(),
    childId: randomUUID(),
    residencyId: randomUUID(),
    arrivalRoundId: randomUUID(),
    destinationChannelId: destination,
    destinationTwitchId: destination,
    retainUnenrolled: true,
  });

  it('reconstructs raids, welcome, contest, historical adoption and a studio across channels', async () => {
    const source = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(source, syntheticSeedCommand());
    const host = {
      ...source,
      channelId: (
        await createSyntheticPeer(pool, source, source.ownerCapability, randomUUID(), 'Host')
      ).channelId,
    };
    await send(host, syntheticSeedCommand());
    await send(host, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    await send(source, raid(host.channelId));
    await advance(source, 3_200);
    await send(host, { type: 'vote', actorKey: 'welcome', choice: 1 });
    await advance(source, 3_200);
    for (const actorKey of ['a', 'b', 'c']) {
      await send(source, { type: 'activity', actorKey });
      await send(host, { type: 'activity', actorKey });
    }
    await advance(source, 12_800);
    // A raid to a channel that enrolls later, then historical adoption by that channel.
    const later = randomUUID();
    await send(source, { ...raid(later), destinationChannelId: null });
    await createSyntheticPeer(pool, source, source.ownerCapability, later, 'Later host');
    const adopter = { ...source, channelId: later };
    const transfer = (
      await pool.query<{ id: string; version: number }>(
        "select id,version from transfers where world_id=$1 and outcome='NOT_ENROLLED'",
        [source.worldId],
      )
    ).rows[0]!;
    await send(adopter, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    await send(adopter, {
      type: 'claimRaid',
      transferId: transfer.id,
      transferVersion: transfer.version,
    });
    // A studio on the source channel within the same world.
    await send(source, {
      type: 'studioSettings',
      settings: { ...defaultStudioSettings, enabled: true, creationMs: 10_000, votingMs: 10_000 },
    });
    await send(source, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    const session = (
      await pool.query<{ id: string; challenge: StudioChallenge }>(
        'select id,challenge from studio_sessions where world_id=$1',
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

    const exported = await exportAcceptedWorld(pool, source.worldId);
    expect(exported.channels).toHaveLength(3);
    expect(
      exported.channels.some((channel) => channel.records.some((r) => r.dependencies.length > 0)),
    ).toBe(true);
    const replayed = await replayAcceptedWorld(pool, exported);
    const comparison = await compareWorldReplay(
      pool,
      source.worldId,
      replayed.worldId,
      replayed.channelIds,
    );
    expect(comparison).toEqual(
      exported.channels.map((channel) => ({ channelId: channel.channelId, equal: true })),
    );
    // Missing a channel the history depends on is refused before any replay world is created.
    const partial: WorldReplay = {
      ...exported,
      channels: exported.channels.filter((channel) => channel.channelId !== host.channelId),
    };
    await expect(replayAcceptedWorld(pool, partial)).rejects.toBeInstanceOf(ReplayIntegrityError);
    // A tampered record breaks its checksum chain.
    const tampered: WorldReplay = {
      ...exported,
      channels: exported.channels.map((channel, index) =>
        index === 0
          ? {
              ...channel,
              records: channel.records.map((r, i) =>
                i === 1 ? { ...r, acceptedAtMs: r.acceptedAtMs + 1 } : r,
              ),
            }
          : channel,
      ),
    };
    await expect(replayAcceptedWorld(pool, tampered)).rejects.toBeInstanceOf(ReplayIntegrityError);
  });
});
