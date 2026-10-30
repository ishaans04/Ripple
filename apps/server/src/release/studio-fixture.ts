import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { founderShell, type StudioChallenge } from '@ripple/contracts';
import { createJudgeWorld } from '../routes/sandbox.ts';
import { acceptSyntheticCommand } from '../game/sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from '../game/synthetic-clock.ts';
import { registerArtistIdentity } from '../privacy/credits.ts';
import { readSnapshot } from '../game/snapshot.ts';

/** Real adapter/worker fixture; all accounts, votes, time and raids are explicitly synthetic. */
export async function releaseStudioFixture(pool: pg.Pool) {
  const world = await createJudgeWorld(pool);
  const send = async (command: unknown, channelId = world.channelId) => {
    await acceptSyntheticCommand(
      pool,
      { ...world, channelId },
      world.ownerCapability,
      randomUUID(),
      command,
    );
    await settleSyntheticWorld(pool, world);
  };
  const advance = async (ms: number) => {
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), ms);
  };
  await send({ type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
  const session = (
    await pool.query<{ id: string; challenge: StudioChallenge }>(
      'select id,challenge from studio_sessions where world_id=$1',
      [world.worldId],
    )
  ).rows[0];
  assert.ok(session, 'Synthetic studio must open');
  const artist = await registerArtistIdentity(
    pool,
    world.worldId,
    'synthetic-restore-account',
    'SyntheticRestoreArtist',
  );
  await send({
    type: 'studioProposal',
    sessionId: session.id,
    proposalId: randomUUID(),
    artistKey: artist.artist_key,
    credit: artist.credit_token,
    creditOptIn: true,
    blueprint: {
      schemaVersion: 1,
      worldId: world.worldId,
      studioSessionId: session.id,
      baseOrganismId: session.challenge.baseOrganismId,
      baseOrganismVersion: session.challenge.baseOrganismVersion,
      mutationTemplateId: session.challenge.mutationTemplateIds[0],
      rendererVersion: 'shell-v1',
      part: founderShell,
    },
  });
  await advance(20000);
  await send({ type: 'vote', actorKey: 'synthetic-restore-voter', choice: 1 });
  await advance(10000);
  const review = (
    await pool.query<{ version: number }>('select version from studio_sessions where world_id=$1', [
      world.worldId,
    ])
  ).rows[0];
  assert.ok(review, 'Synthetic review must exist');
  await send({
    type: 'studioReview',
    sessionId: session.id,
    sessionVersion: review.version,
    decision: 'approve',
    adaptationId: randomUUID(),
  });
  await advance(3200);
  assert.equal(
    (await readSnapshot(pool, world.worldId, world.channelId))?.payload.organism?.appearance.kind,
    'studio',
  );
  await send({ type: 'studioReturn', trigger: 'manual' });
  await send({
    type: 'raid',
    transferId: randomUUID(),
    childId: randomUUID(),
    residencyId: randomUUID(),
    arrivalRoundId: randomUUID(),
    destinationTwitchId: world.neighborId,
    destinationChannelId: world.neighborId,
    sourceAuthorized: true,
  });
  const child = await pool.query(
    'select id from transfers where world_id=$1 and child_id is not null',
    [world.worldId],
  );
  assert.equal(child.rowCount, 1);
  return { ...world, artistKey: artist.artist_key, creditToken: artist.credit_token };
}
