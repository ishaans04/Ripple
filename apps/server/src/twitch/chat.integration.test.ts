import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, runMigrations, scanDeadlines } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
} from '../game/sandbox.ts';
import { processNextInput } from '../game/worker.ts';
describe('ordered live chat identity scoping', () => {
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
  it('keeps first-vote identity stable across worker delay and caps activity per observation bucket', async () => {
    const world = await createSyntheticWorld(pool);
    const actorBase = 'a'.repeat(64);
    await acceptSyntheticCommand(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      syntheticSeedCommand(),
    );
    await processNextInput(pool, world.worldId, world.channelId);
    const send = async (command: unknown) => {
      const at = (
        await pool.query<{ clock_at: Date }>('select clock_at from worlds where id=$1', [
          world.worldId,
        ])
      ).rows[0]!.clock_at.getTime();
      await acceptInput(pool, {
        ...world,
        provider: 'chat-fixture',
        messageId: randomUUID(),
        command,
        acceptedAtMs: at,
      });
    };
    await send({ type: 'twitch.chat', actorBase, action: 'vote', choice: 1 });
    await send({ type: 'twitch.chat', actorBase, action: 'vote', choice: 2 });
    expect((await processNextInput(pool, world.worldId, world.channelId))?.effect.code).toBe(
      'APPLIED',
    );
    expect((await processNextInput(pool, world.worldId, world.channelId))?.effect.code).toBe(
      'ALREADY_VOTED',
    );
    const due = (
      await pool.query<{ due_at: Date }>('select due_at from deadlines where world_id=$1', [
        world.worldId,
      ])
    ).rows[0]!.due_at;
    await pool.query<Record<string, unknown>>('update worlds set clock_at=$2 where id=$1', [
      world.worldId,
      due,
    ]);
    await scanDeadlines(pool);
    await processNextInput(pool, world.worldId, world.channelId);
    for (let n = 0; n < 3; n++) await send({ type: 'twitch.chat', actorBase, action: 'activity' });
    for (let n = 0; n < 3; n++) await processNextInput(pool, world.worldId, world.channelId);
    expect(
      (
        await pool.query<Record<string, unknown>>(
          'select * from activity_contributions where world_id=$1',
          [world.worldId],
        )
      ).rowCount,
    ).toBe(1);
    const events = await pool.query<{ command: { type: string; actorKey?: string } }>(
      'select command from game_events where world_id=$1 order by sequence',
      [world.worldId],
    );
    expect(events.rows[1]?.command.type).toBe('vote');
    expect(events.rows[1]?.command.actorKey).not.toBe(actorBase);
    expect(JSON.stringify(events.rows)).not.toContain('actorBase');
  });
});
