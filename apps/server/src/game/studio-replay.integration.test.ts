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
import {
  ReplayIntegrityError,
  canonicalGameProjection,
  exportAcceptedChannel,
  replayAcceptedChannel,
} from './replay.ts';

describe('studio replay from accepted records', () => {
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
  async function send(scope: SyntheticWorld, value: unknown) {
    await acceptSyntheticCommand(pool, scope, scope.ownerCapability, randomUUID(), value);
    await settleSyntheticWorld(pool, scope);
  }
  async function advance(scope: SyntheticWorld, ms: number) {
    await advanceSyntheticClock(pool, scope, scope.ownerCapability, randomUUID(), ms);
  }

  it('reproduces sessions, proposals, the selection, approval, hatch and appearance without cameras', async () => {
    const source = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(source, syntheticSeedCommand());
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
    for (const [name, template] of session.challenge.mutationTemplateIds.slice(0, 2).entries())
      await send(source, {
        type: 'studioProposal',
        sessionId: session.id,
        proposalId: randomUUID(),
        artistKey: createHash('sha256').update(`artist-${name}`).digest('hex'),
        credit: `artist${name}`,
        creditOptIn: name === 0,
        blueprint: {
          schemaVersion: 1,
          worldId: session.challenge.worldId,
          studioSessionId: session.id,
          baseOrganismId: session.challenge.baseOrganismId,
          baseOrganismVersion: session.challenge.baseOrganismVersion,
          mutationTemplateId: template,
          rendererVersion: 'shell-v1',
          part: {
            ...founderShell,
            parameters: { ...founderShell.parameters, height: 300 + name * 100 },
          },
        },
      });
    await advance(source, 10_000);
    for (const [index, actorKey] of ['a', 'b', 'c', 'd', 'e'].entries())
      await send(source, { type: 'vote', actorKey, choice: index < 3 ? 1 : 2 });
    await advance(source, 10_000);
    const review = (
      await pool.query<{ version: number }>(
        'select version from studio_sessions where world_id=$1',
        [source.worldId],
      )
    ).rows[0]!;
    await send(source, {
      type: 'studioReview',
      sessionId: session.id,
      sessionVersion: review.version,
      decision: 'approve',
      adaptationId: randomUUID(),
    });
    await advance(source, 3_200);
    for (const actorKey of ['x', 'y', 'z']) await send(source, { type: 'activity', actorKey });
    await advance(source, 12_000);
    const sourceProjection = await canonicalGameProjection(pool, source);
    expect(sourceProjection).toContain('"phase":"COMPLETED"');
    expect(sourceProjection).toContain('"kind":"studio"');

    const bundle = await exportAcceptedChannel(pool, source);
    expect(bundle.sourceWorldId).toBe(source.worldId);
    const replayed = await replayAcceptedChannel(pool, bundle);
    expect(replayed.worldId).not.toBe(source.worldId);
    expect(await canonicalGameProjection(pool, replayed)).toBe(sourceProjection);
    // Reconstruction never touches the source world.
    expect(await canonicalGameProjection(pool, source)).toBe(sourceProjection);
    // A studio history cannot be reconstructed without the world bound into its blueprints.
    const withoutWorld = { ...bundle };
    delete withoutWorld.sourceWorldId;
    await expect(replayAcceptedChannel(pool, withoutWorld)).rejects.toBeInstanceOf(
      ReplayIntegrityError,
    );
  });
});
