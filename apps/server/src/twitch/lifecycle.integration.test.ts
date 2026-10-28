import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
} from '../game/sandbox.ts';
import { processNextInput } from '../game/worker.ts';
import { readSnapshot } from '../game/snapshot.ts';
describe('independent stream and input health signals', () => {
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
  it('resumes clean offline time but preserves manual pauses and explicit outage recovery', async () => {
    const world = await createSyntheticWorld(pool);
    const send = async (command: unknown) => {
      await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), command);
      return processNextInput(pool, world.worldId, world.channelId);
    };
    await send(syntheticSeedCommand());
    await send({ type: 'stream', online: false });
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))?.payload.round?.clock.paused,
    ).toBe(true);
    await send({ type: 'stream', online: true });
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))?.payload.round?.clock.paused,
    ).toBe(false);
    await send({ type: 'pause', reason: 'manual' });
    await send({ type: 'stream', online: false });
    await send({ type: 'stream', online: true });
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))?.payload.round?.clock.paused,
    ).toBe(true);
    await send({ type: 'resume' });
    await send({ type: 'inputHealth', healthy: false });
    await send({ type: 'stream', online: true });
    await send({ type: 'inputHealth', healthy: true });
    expect((await readSnapshot(pool, world.worldId, world.channelId))?.payload.round?.phase).toBe(
      'INTERRUPTED',
    );
    await send({ type: 'recover' });
    expect((await readSnapshot(pool, world.worldId, world.channelId))?.payload.round?.phase).toBe(
      'VOTING',
    );
  });
});
