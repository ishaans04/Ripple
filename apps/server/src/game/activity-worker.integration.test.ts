import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { acceptInput, runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { createSyntheticWorld, acceptSyntheticCommand, syntheticSeedCommand } from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { canonicalGameProjection, exportAcceptedChannel, replayAcceptedChannel } from './replay.ts';
import { processNextInput } from './worker.ts';
import { processActivityBatch } from './activity-worker.ts';
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
it('batches ordinary activity into byte-identical accepted records and never crosses a control boundary', async () => {
  const source = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
  await acceptSyntheticCommand(
    pool,
    source,
    source.ownerCapability,
    randomUUID(),
    syntheticSeedCommand(),
  );
  await settleSyntheticWorld(pool, source);
  await advanceSyntheticClock(pool, source, source.ownerCapability, randomUUID(), 3200);
  const baseline = await replayAcceptedChannel(pool, await exportAcceptedChannel(pool, source));
  const clock = (
    await pool.query<{ clock_at: Date }>('select clock_at from worlds where id=$1', [
      source.worldId,
    ])
  ).rows[0]!.clock_at.getTime();
  const commands = [
    ...Array.from({ length: 8 }, (_, i) => ({
      type: 'twitch.chat',
      actorBase: (i % 2 ? 'b' : 'a').repeat(64),
      action: 'activity',
    })),
    { type: 'pause', reason: 'manual' },
    ...Array.from({ length: 3 }, () => ({ type: 'activity', actorKey: 'paused-actor' })),
  ];
  for (const [index, command] of commands.entries())
    for (const scope of [source, baseline])
      await acceptInput(pool, {
        worldId: scope.worldId,
        channelId: scope.channelId,
        provider: 'batch-regression',
        messageId: String(index),
        command,
        acceptedAtMs: clock + index + 1,
      });
  expect((await processActivityBatch(pool, source.worldId, source.channelId))?.length).toBe(4);
  expect((await processActivityBatch(pool, source.worldId, source.channelId))?.length).toBe(4);
  expect(await processActivityBatch(pool, source.worldId, source.channelId)).toBeNull();
  await processNextInput(pool, source.worldId, source.channelId);
  expect((await processActivityBatch(pool, source.worldId, source.channelId))?.length).toBe(3);
  while ((await processNextInput(pool, baseline.worldId, baseline.channelId)) !== null) {
    /* Single-record reference worker. */
  }
  const actual = await exportAcceptedChannel(pool, source),
    expected = await exportAcceptedChannel(pool, baseline);
  expect(actual.records).toEqual(expected.records);
  expect(await canonicalGameProjection(pool, source)).toBe(
    await canonicalGameProjection(pool, baseline),
  );
  expect(
    (await pool.query('select 1 from activity_contributions where world_id=$1', [source.worldId]))
      .rowCount,
  ).toBe(2);
});
it('rolls back every record and membership entry if the batched durable write fails', async () => {
  const source = await createSyntheticWorld(pool);
  await acceptSyntheticCommand(
    pool,
    source,
    source.ownerCapability,
    randomUUID(),
    syntheticSeedCommand(),
  );
  await settleSyntheticWorld(pool, source);
  for (let i = 0; i < 3; i++)
    await acceptSyntheticCommand(pool, source, source.ownerCapability, randomUUID(), {
      type: 'activity',
      actorKey: String(i),
    });
  await pool.query(
    `create function fail_activity_batch() returns trigger language plpgsql as $$ begin raise exception 'batch disk failure'; end $$`,
  );
  await pool.query(
    'create trigger fail_activity_batch before insert on game_events for each row execute function fail_activity_batch()',
  );
  try {
    await expect(processActivityBatch(pool, source.worldId, source.channelId)).rejects.toThrow(
      'batch disk failure',
    );
  } finally {
    await pool.query('drop trigger fail_activity_batch on game_events');
    await pool.query('drop function fail_activity_batch()');
  }
  expect(
    (
      await pool.query<{ processed_sequence: number }>(
        'select processed_sequence from channels where world_id=$1',
        [source.worldId],
      )
    ).rows[0]?.processed_sequence,
  ).toBe(1);
  expect((await processActivityBatch(pool, source.worldId, source.channelId))?.length).toBe(3);
});
