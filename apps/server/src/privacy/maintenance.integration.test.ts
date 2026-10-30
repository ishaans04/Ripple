import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { founderShell, type StudioChallenge } from '@ripple/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { acceptInput, runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { createJudgeWorld } from '../routes/sandbox.ts';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
} from '../game/sandbox.ts';
import { settleSyntheticWorld } from '../game/synthetic-clock.ts';
import {
  exportAcceptedWorld,
  replayAcceptedWorld,
  compareWorldReplay,
} from '../game/world-replay.ts';
import { maintainData, purgeExpiredWorld } from './maintenance.ts';
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
it('expires processed raw input while preserving replay and permanent receipt conflict protection', async () => {
  const world = await createSyntheticWorld(pool),
    command = syntheticSeedCommand(),
    messageId = randomUUID();
  await acceptSyntheticCommand(pool, world, world.ownerCapability, messageId, command);
  await settleSyntheticWorld(pool, world);
  const before = await exportAcceptedWorld(pool, world.worldId);
  await pool.query("update inbox set processed_at=now()-interval '2 days' where world_id=$1", [
    world.worldId,
  ]);
  const pending = {
    worldId: world.worldId,
    channelId: world.channelId,
    provider: 'synthetic',
    messageId: randomUUID(),
    command: { type: 'pause', reason: 'manual' },
  };
  await acceptInput(pool, pending);
  expect((await maintainData(pool)).deleted.rawInputs).toBe(1);
  expect(
    (await pool.query('select 1 from inbox where world_id=$1', [world.worldId])).rowCount,
  ).toBe(1);
  expect(
    await acceptSyntheticCommand(pool, world, world.ownerCapability, messageId, command),
  ).toMatchObject({ duplicate: true, sequence: 1 });
  await expect(
    acceptSyntheticCommand(pool, world, world.ownerCapability, messageId, { type: 'resume' }),
  ).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' });
  const after = await exportAcceptedWorld(pool, world.worldId);
  expect(after).toEqual(before);
  const replay = await replayAcceptedWorld(pool, after);
  expect(
    (await compareWorldReplay(pool, world.worldId, replay.worldId, replay.channelIds)).every(
      (row) => row.equal,
    ),
  ).toBe(true);
});
it('purges only explicitly expired worlds atomically, including immutable studio history and descendants', async () => {
  const first = await createJudgeWorld(pool),
    other = await createJudgeWorld(pool);
  const send = async (command: unknown) => {
    await acceptSyntheticCommand(pool, first, first.ownerCapability, randomUUID(), command);
    await settleSyntheticWorld(pool, first);
  };
  await send({ type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
  const session = (
    await pool.query<{ id: string; challenge: StudioChallenge }>(
      'select id,challenge from studio_sessions where world_id=$1',
      [first.worldId],
    )
  ).rows[0]!;
  await send({
    type: 'studioProposal',
    sessionId: session.id,
    proposalId: randomUUID(),
    artistKey: 'a'.repeat(64),
    credit: 'Synthetic artist',
    creditOptIn: false,
    blueprint: {
      schemaVersion: 1,
      worldId: first.worldId,
      studioSessionId: session.id,
      baseOrganismId: session.challenge.baseOrganismId,
      baseOrganismVersion: session.challenge.baseOrganismVersion,
      mutationTemplateId: session.challenge.mutationTemplateIds[0],
      rendererVersion: 'shell-v1',
      part: founderShell,
    },
  });
  await expect(purgeExpiredWorld(pool, first.worldId)).rejects.toThrow('expired');
  await pool.query('update worlds set expires_at=now() where id=$1', [first.worldId]);
  const result = await purgeExpiredWorld(pool, first.worldId);
  expect(result.deleted.organisms).toBe(2);
  expect(result.deleted.appearance_blueprints).toBe(1);
  expect(result.deleted.studio_transitions).toBeGreaterThan(0);
  expect((await pool.query('select 1 from worlds where id=$1', [first.worldId])).rowCount).toBe(0);
  expect(
    (await pool.query('select 1 from organisms where world_id=$1', [other.worldId])).rowCount,
  ).toBe(2);
});
