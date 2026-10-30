import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockChannels, runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import type { PropagationCommand } from '@ripple/contracts';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { processNextInput } from './worker.ts';
import { loadContext } from './store.ts';
import { forkRaid } from './raid-fork.ts';
import { applyAdmissionCommand, sweepAdmissions, type AdmissionEligibility } from './admissions.ts';
import type { TransferRow } from './propagation-store.ts';
describe('ordered destination admission', () => {
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
  async function setup() {
    const world = await createSyntheticWorld(pool);
    await acceptSyntheticCommand(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      syntheticSeedCommand(),
    );
    await processNextInput(pool, world.worldId, world.channelId);
    const target = randomUUID();
    await pool.query(
      `insert into channels(world_id,id,label,rules_hash,seed,configuration,online,healthy,initial_online,initial_healthy) select world_id,$3,'Synthetic receiver',rules_hash,$4,configuration,true,true,true,true from channels where world_id=$1 and id=$2`,
      [world.worldId, world.channelId, target, 'receiver-seed'],
    );
    await pool.query(
      "insert into twitch_channels(world_id,channel_id,visitor_policy) values($1,$2,'accept')",
      [world.worldId, target],
    );
    const cmd: Extract<PropagationCommand, { type: 'raid' }> = {
      type: 'raid',
      transferId: randomUUID(),
      childId: randomUUID(),
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: target,
      destinationTwitchId: target,
    };
    const at = (
      await pool.query<{ clock_at: Date }>('select clock_at from worlds where id=$1', [
        world.worldId,
      ])
    ).rows[0]!.clock_at.getTime();
    await transaction(pool, async (client) => {
      await lockChannels(client, world.worldId, [world.channelId, target]);
      await forkRaid(
        await loadContext(client, world.worldId, world.channelId),
        cmd,
        randomUUID(),
        2,
        at,
      );
    });
    return { world, target, cmd, at };
  }
  async function admit(
    fixture: Awaited<ReturnType<typeof setup>>,
    eligibility: AdmissionEligibility = { authorized: true, rulesCompatible: true },
    at = fixture.at,
  ) {
    return transaction(pool, async (client) => {
      await lockChannels(client, fixture.world.worldId, [fixture.target]);
      return applyAdmissionCommand(
        await loadContext(client, fixture.world.worldId, fixture.target),
        {
          type: 'arrive',
          transferId: fixture.cmd.transferId,
          roundId: fixture.cmd.arrivalRoundId,
          eligibility,
        },
        1,
        at,
      );
    });
  }
  async function outcome(world: SyntheticWorld, id: string) {
    return (
      await pool.query<TransferRow>('select * from transfers where world_id=$1 and id=$2', [
        world.worldId,
        id,
      ])
    ).rows[0]!;
  }
  it('activates once with a captured visitor residency, retaining the source parent', async () => {
    const f = await setup();
    expect((await admit(f)).detail.outcome).toBe('ACTIVE');
    expect((await admit(f)).code).toBe('NO_CHANGE');
    expect(
      (
        await pool.query<{ role: string; organism_id: string }>(
          'select role,organism_id from residencies where world_id=$1 and channel_id=$2 and ended_at is null',
          [f.world.worldId, f.target],
        )
      ).rows,
    ).toEqual([{ role: 'visitor', organism_id: f.cmd.childId }]);
    expect(
      (
        await pool.query<{ status: string }>(
          'select status from organisms where world_id=$1 and id=$2',
          [f.world.worldId, f.cmd.childId],
        )
      ).rows[0]?.status,
    ).toBe('ALIVE');
    expect(
      (
        await pool.query(
          "select 1 from residencies where world_id=$1 and channel_id=$2 and role='resident' and ended_at is null",
          [f.world.worldId, f.world.channelId],
        )
      ).rowCount,
    ).toBe(1);
  });
  it('keeps approval, offline, revoked and incompatible arrivals inert rather than simulating them', async () => {
    for (const reason of ['approval', 'offline', 'grant', 'rules'] as const) {
      const f = await setup();
      if (reason === 'approval')
        await pool.query(
          "update twitch_channels set visitor_policy='ask' where world_id=$1 and channel_id=$2",
          [f.world.worldId, f.target],
        );
      if (reason === 'offline')
        await pool.query('update channels set online=false where world_id=$1 and id=$2', [
          f.world.worldId,
          f.target,
        ]);
      const expected = {
        approval: 'PENDING_APPROVAL',
        offline: 'OFFLINE_HOLD',
        grant: 'GRANT_REVOKED',
        rules: 'RULES_INCOMPATIBLE',
      }[reason];
      expect(
        (await admit(f, { authorized: reason !== 'grant', rulesCompatible: reason !== 'rules' }))
          .detail.outcome,
      ).toBe(expected);
      expect(
        (
          await pool.query<{ status: string; health: number }>(
            'select status,health from organisms where world_id=$1 and id=$2',
            [f.world.worldId, f.cmd.childId],
          )
        ).rows,
      ).toEqual([{ status: 'HARBOR', health: 32 }]);
      expect(
        (
          await pool.query('select 1 from rounds where world_id=$1 and channel_id=$2', [
            f.world.worldId,
            f.target,
          ])
        ).rowCount,
      ).toBe(0);
    }
  });
  it('approves with an entity version, rejects stale retries and archives declines without extinction', async () => {
    const f = await setup();
    await pool.query(
      "update twitch_channels set visitor_policy='ask' where world_id=$1 and channel_id=$2",
      [f.world.worldId, f.target],
    );
    await admit(f);
    const held = await outcome(f.world, f.cmd.transferId);
    const decide = async (version: number, decision: 'accept' | 'decline') =>
      transaction(pool, async (client) => {
        await lockChannels(client, f.world.worldId, [f.target]);
        return applyAdmissionCommand(
          await loadContext(client, f.world.worldId, f.target),
          {
            type: 'admission',
            transferId: f.cmd.transferId,
            transferVersion: version,
            decision,
            roundId: f.cmd.arrivalRoundId,
            eligibility: { authorized: true, rulesCompatible: true },
          },
          2,
          f.at + 1,
        );
      });
    expect((await decide(held.version - 1, 'accept')).code).toBe('STALE_VERSION');
    expect((await decide(held.version, 'accept')).detail.outcome).toBe('ACTIVE');
    const active = await outcome(f.world, f.cmd.transferId);
    expect((await decide(active.version, 'decline')).detail.outcome).toBe('DECLINED');
    expect(
      (
        await pool.query<{ status: string; health: number }>(
          'select status,health from organisms where world_id=$1 and id=$2',
          [f.world.worldId, f.cmd.childId],
        )
      ).rows,
    ).toEqual([{ status: 'ARCHIVED', health: 32 }]);
  });
  it('expires pending admission at its wall-clock boundary and cannot revive it after reconnect', async () => {
    const f = await setup();
    await pool.query('update channels set online=false where world_id=$1 and id=$2', [
      f.world.worldId,
      f.target,
    ]);
    await admit(f);
    const expiry = (await outcome(f.world, f.cmd.transferId)).expires_at!.getTime();
    expect((await admit(f, undefined, expiry)).detail.outcome).toBe('EXPIRED');
    await pool.query('update channels set online=true where world_id=$1 and id=$2', [
      f.world.worldId,
      f.target,
    ]);
    const sweep = await transaction(pool, async (client) => {
      await lockChannels(client, f.world.worldId, [f.target]);
      return sweepAdmissions(await loadContext(client, f.world.worldId, f.target), 3, expiry + 1, {
        authorized: true,
        rulesCompatible: true,
      });
    });
    expect(sweep.code).toBe('NO_CHANGE');
    expect((await outcome(f.world, f.cmd.transferId)).outcome).toBe('EXPIRED');
  });
});
