import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { processNextInput } from './worker.ts';
import { readSnapshot } from './snapshot.ts';

describe('transaction rollback and recovery boundaries', () => {
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
  async function command(world: SyntheticWorld, value: unknown) {
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), value);
    await settleSyntheticWorld(pool, world);
  }
  async function start() {
    const world = await createSyntheticWorld(pool);
    await command(world, syntheticSeedCommand());
    return world;
  }
  it('publishes pause/resume for an empty channel and permits seeding after resume', async () => {
    const world = await createSyntheticWorld(pool);
    await command(world, { type: 'pause', reason: 'manual' });
    expect(await readSnapshot(pool, world.worldId, world.channelId)).toMatchObject({
      version: 1,
      payload: { paused: true },
    });
    await command(world, { type: 'resume' });
    expect(await readSnapshot(pool, world.worldId, world.channelId)).toMatchObject({
      version: 2,
      payload: { paused: false },
    });
    await command(world, syntheticSeedCommand());
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))?.payload.organism?.health,
    ).toBe(70);
  });
  it('allows explicit manual resume followed by recovery after an outage during pause', async () => {
    const world = await start();
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), 3200);
    await command(world, { type: 'pause', reason: 'manual' });
    await command(world, { type: 'interrupt', reason: 'input_outage' });
    await command(world, { type: 'integration', online: true, healthy: true });
    await command(world, { type: 'resume' });
    await command(world, { type: 'recover' });
    expect((await readSnapshot(pool, world.worldId, world.channelId))?.payload).toMatchObject({
      paused: false,
      healthy: true,
      round: {
        phase: 'OBSERVING',
        clock: { observationEpoch: 1, paused: false, remainingMs: 12000 },
      },
    });
  });
  it('rolls back state, cursor, event and outbox together if the final write fails', async () => {
    const world = await start();
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), {
      type: 'vote',
      actorKey: 'rollback',
      choice: 1,
    });
    await pool.query(
      `create function fail_outbox_for_test() returns trigger language plpgsql as $$ begin raise exception 'injected outbox failure'; end $$`,
    );
    await pool.query(
      'create trigger fail_outbox_for_test before insert on public_updates for each row execute function fail_outbox_for_test()',
    );
    try {
      await expect(processNextInput(pool, world.worldId, world.channelId)).rejects.toThrow(
        'injected outbox failure',
      );
    } finally {
      await pool.query('drop trigger fail_outbox_for_test on public_updates');
    }
    expect(
      (await pool.query('select * from votes where world_id=$1', [world.worldId])).rowCount,
    ).toBe(0);
    expect(
      (await pool.query('select * from game_events where world_id=$1', [world.worldId])).rowCount,
    ).toBe(1);
    expect(
      (await readSnapshot(pool, world.worldId, world.channelId))?.payload.round?.counts,
    ).toEqual([0, 0, 0]);
    expect((await processNextInput(pool, world.worldId, world.channelId))?.effect.code).toBe(
      'APPLIED',
    );
  });
  it('survives an actual worker process killed immediately after its transaction commits', async () => {
    const world = await start();
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), {
      type: 'vote',
      actorKey: 'crash',
      choice: 3,
    });
    const entry = new URL('./worker.ts', import.meta.url).href;
    const script = `import pg from 'pg';import {processNextInput} from ${JSON.stringify(entry)};const pool=new pg.Pool({connectionString:process.env.RIPPLE_TEST_WORKER_DB,connectionTimeoutMillis:5000});await processNextInput(pool,process.env.RIPPLE_TEST_WORLD,process.env.RIPPLE_TEST_CHANNEL);process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(
      process.execPath,
      ['--conditions=ripple-source', '--input-type=module', '-e', script],
      {
        env: {
          ...process.env,
          RIPPLE_TEST_WORKER_DB: temporary.connectionString,
          RIPPLE_TEST_WORLD: world.worldId,
          RIPPLE_TEST_CHANNEL: world.channelId,
        },
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    expect(child.stderr).toBe('');
    const restarted = new pg.Pool({ connectionString: temporary.connectionString });
    try {
      expect(await processNextInput(restarted, world.worldId, world.channelId)).toBeNull();
      expect(
        (await readSnapshot(restarted, world.worldId, world.channelId))?.payload.round?.counts,
      ).toEqual([0, 0, 1]);
      expect(
        (await restarted.query('select * from public_updates where world_id=$1', [world.worldId]))
          .rowCount,
      ).toBe(2);
    } finally {
      await restarted.end();
    }
  }, 20_000);
  it('does not apply queued gameplay after the world has expired', async () => {
    const world = await start();
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), {
      type: 'vote',
      actorKey: 'expired',
      choice: 1,
    });
    await pool.query(`update worlds set expires_at=now()-interval '1 second' where id=$1`, [
      world.worldId,
    ]);
    expect(await processNextInput(pool, world.worldId, world.channelId)).toBeNull();
    expect(
      (await pool.query('select * from votes where world_id=$1', [world.worldId])).rowCount,
    ).toBe(0);
  });
});
