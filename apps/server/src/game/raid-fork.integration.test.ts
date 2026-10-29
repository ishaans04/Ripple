import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockChannels, runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { propagationCommandSchema, type PropagationCommand } from '@ripple/contracts';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { processNextInput } from './worker.ts';
import { loadContext } from './store.ts';
import { forkRaid } from './raid-fork.ts';
import type { TransferRow } from './propagation-store.ts';

describe('atomic parent snapshots and bounded child forks', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
  }, 20000);
  afterAll(async () => {
    await pool.end();
    await temporary.drop();
  });
  async function destination(world: SyntheticWorld): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into channels(world_id,id,label,rules_hash,seed,configuration,online,healthy,initial_online,initial_healthy) select world_id,$3,'Synthetic receiving channel',rules_hash,$4,configuration,true,true,true,true from channels where world_id=$1 and id=$2`,
      [world.worldId, world.channelId, id, id],
    );
    return id;
  }
  function command(id: string | null): Extract<PropagationCommand, { type: 'raid' }> {
    return propagationCommandSchema.parse({
      type: 'raid',
      transferId: randomUUID(),
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: id,
      destinationTwitchId: id ?? 'not-enrolled',
    }) as Extract<PropagationCommand, { type: 'raid' }>;
  }
  async function fork(
    world: SyntheticWorld,
    cmd: Extract<PropagationCommand, { type: 'raid' }>,
    receipt = randomUUID(),
  ) {
    return transaction(pool, async (client) => {
      await lockChannels(client, world.worldId, [
        world.channelId,
        ...(cmd.destinationChannelId === null ? [] : [cmd.destinationChannelId]),
      ]);
      const context = await loadContext(client, world.worldId, world.channelId);
      return forkRaid(
        context,
        cmd,
        receipt,
        context.channel.processed_sequence + 1,
        (
          await client.query<{ clock_at: Date }>('select clock_at from worlds where id=$1', [
            world.worldId,
          ])
        ).rows[0]!.clock_at.getTime(),
      );
    });
  }
  async function seeded() {
    const world = await createSyntheticWorld(pool);
    await acceptSyntheticCommand(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      syntheticSeedCommand(),
    );
    await processNextInput(pool, world.worldId, world.channelId);
    return world;
  }
  it('captures only committed parent state, queues destination processing and retries the existing result', async () => {
    const world = await seeded(),
      target = await destination(world),
      cmd = command(target),
      receipt = randomUUID();
    const parent = (
      await pool.query<{ id: string; health: number }>(
        'select id,health from organisms where world_id=$1',
        [world.worldId],
      )
    ).rows[0]!;
    const result = await fork(world, cmd, receipt);
    expect(result.detail).toMatchObject({ outcome: 'QUEUED', childId: cmd.childId });
    const transfer = (
      await pool.query<TransferRow>('select * from transfers where world_id=$1', [world.worldId])
    ).rows[0]!;
    expect(transfer.snapshot.parent).toMatchObject({
      id: parent.id,
      health: parent.health,
      genome: { pulse: 6, calm: 6, grit: 6, drift: 6 },
    });
    expect(
      (
        await pool.query<{ pulse: number; calm: number; health: number; status: string }>(
          'select pulse,calm,health,status from organisms where world_id=$1 and id=$2',
          [world.worldId, cmd.childId],
        )
      ).rows,
    ).toEqual([{ pulse: 6, calm: 6, health: 32, status: 'HARBOR' }]);
    expect(
      (
        await pool.query('select 1 from residencies where world_id=$1 and organism_id=$2', [
          world.worldId,
          cmd.childId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query<{ command: unknown }>(
          "select command from inbox where world_id=$1 and channel_id=$2 and provider='raid-arrival'",
          [world.worldId, target],
        )
      ).rows,
    ).toEqual([
      { command: { type: 'arrive', transferId: cmd.transferId, roundId: cmd.arrivalRoundId } },
    ]);
    expect((await fork(world, cmd, receipt)).detail).toMatchObject({
      transferId: cmd.transferId,
      outcome: 'QUEUED',
      duplicate: true,
    });
    expect((await fork(world, command(target))).detail.outcome).toBe('FORK_COOLDOWN');
    await pool.query('update organisms set pulse=8,calm=4,health=85 where world_id=$1 and id=$2', [
      world.worldId,
      parent.id,
    ]);
    expect(
      (
        await pool.query<{ pulse: number; calm: number; health: number }>(
          'select pulse,calm,health from organisms where world_id=$1 and id=$2',
          [world.worldId, cmd.childId],
        )
      ).rows,
    ).toEqual([{ pulse: 6, calm: 6, health: 32 }]);
  }, 20000);
  it('rolls back child, transfer, destination receipt and expiry together on a durable job failure', async () => {
    const world = await seeded(),
      target = await destination(world),
      cmd = command(target);
    await pool.query(
      "create function pg_temp.reject_admission_job() returns trigger language plpgsql as $$ begin if new.job_key like 'admission-expiry:%' then raise exception 'injected expiry failure'; end if; return new; end; $$",
    );
    await pool.query(
      'create trigger reject_admission_job before insert on deadlines for each row execute function pg_temp.reject_admission_job()',
    );
    try {
      await expect(fork(world, cmd)).rejects.toThrow('injected expiry failure');
    } finally {
      await pool.query('drop trigger reject_admission_job on deadlines');
    }
    expect(
      (
        await pool.query('select 1 from organisms where world_id=$1 and id=$2', [
          world.worldId,
          cmd.childId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await pool.query('select 1 from transfers where world_id=$1', [world.worldId])).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query<{ intake_sequence: number }>(
          'select intake_sequence from channels where world_id=$1 and id=$2',
          [world.worldId, target],
        )
      ).rows[0]?.intake_sequence,
    ).toBe(0);
  });
  it('records absent sources and unenrolled destinations without fabricating descendants', async () => {
    const empty = await createSyntheticWorld(pool);
    expect((await fork(empty, command(null))).detail.outcome).toBe('SOURCE_INELIGIBLE');
    const world = await seeded();
    expect((await fork(world, command(null))).detail.outcome).toBe('NOT_ENROLLED');
    await pool.query(
      "update organisms set health=0,status='FOSSIL',version=version+1 where world_id=$1",
      [world.worldId],
    );
    expect((await fork(world, command(null))).detail.outcome).toBe('SOURCE_INELIGIBLE');
    expect(
      (await pool.query('select 1 from organisms where world_id=$1', [world.worldId])).rowCount,
    ).toBe(1);
  });
});
