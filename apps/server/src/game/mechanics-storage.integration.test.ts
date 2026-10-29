import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  candidateMechanicsPolicy,
  consumeValidRound,
  mechanicsPolicyHash,
  newValidRoundLifetime,
} from '@ripple/engine';
import { acceptSyntheticCommand, createSyntheticWorld, syntheticSeedCommand } from './sandbox.ts';
import { settleSyntheticWorld } from './synthetic-clock.ts';
import { loadContext } from './store.ts';

describe('mechanic storage provenance and allowances', () => {
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
  async function seeded() {
    const world = await createSyntheticWorld(pool);
    const seed = syntheticSeedCommand();
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), seed);
    await settleSyntheticWorld(pool, world);
    return { world, seed };
  }
  it('pins the world policy, preserves legacy genesis and initializes explicit new genesis', async () => {
    const { world } = await seeded();
    const client = await pool.connect();
    try {
      const context = await loadContext(client, world.worldId, world.channelId);
      expect(context.mechanics).toEqual({
        version: 0,
        requested: false,
        tracesEnabled: true,
        policy: candidateMechanicsPolicy,
      });
    } finally {
      client.release();
    }
    expect(
      (
        await pool.query('select policy_hash from world_mechanics_policies where world_id=$1', [
          world.worldId,
        ])
      ).rows[0],
    ).toEqual({ policy_hash: mechanicsPolicyHash(candidateMechanicsPolicy) });
    const peer = randomUUID();
    await pool.query(
      `insert into channels(world_id,id,label,rules_hash,seed,configuration,initial_mechanics_version)
       select world_id,$3,'New mechanics genesis',rules_hash,seed,configuration,1 from channels where world_id=$1 and id=$2`,
      [world.worldId, world.channelId, peer],
    );
    expect(
      (
        await pool.query(
          'select mechanics_version from channel_play where world_id=$1 and channel_id=$2',
          [world.worldId, peer],
        )
      ).rows[0],
    ).toEqual({ mechanics_version: 1 });
    await expect(
      pool.query('update channels set initial_mechanics_version=0 where world_id=$1 and id=$2', [
        world.worldId,
        peer,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('update mechanics_policies set canonical=canonical'),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('update world_mechanics_policies set policy_hash=policy_hash where world_id=$1', [
        world.worldId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects malformed, duplicated and inconsistent lifetime checkpoints', async () => {
    const birth = randomUUID(),
      other = randomUUID();
    const check = async (value: unknown, remaining = 2) =>
      (
        await pool.query<{ valid: boolean }>(
          'select valid_mechanic_lifetime($1::jsonb,$2::uuid,$3) as valid',
          [JSON.stringify(value), birth, remaining],
        )
      ).rows[0]!.valid;
    const valid = { birthRoundId: birth, remainingRounds: 2, countedRoundIds: [other] };
    expect(await check(valid)).toBe(true);
    expect(await check({ ...valid, countedRoundIds: [other, other] })).toBe(false);
    expect(await check({ ...valid, countedRoundIds: [birth] })).toBe(false);
    expect(await check({ ...valid, birthRoundId: other })).toBe(false);
    expect(await check({ ...valid, remainingRounds: 3 })).toBe(false);
    expect(await check({ ...valid, countedRoundIds: [17] })).toBe(false);
    expect(await check({ ...valid, countedRoundIds: 'not an array' })).toBe(false);
    expect(await check(null)).toBe(false);
    expect(await check(newValidRoundLifetime(birth, 3), 3)).toBe(true);
  });
  it('ages dormant state without permitting renewal, edited ancestry or terminal revival', async () => {
    const { world, seed } = await seeded(),
      id = randomUUID();
    const born = newValidRoundLifetime(seed.roundId, 3);
    await pool.query(
      `insert into dormant_mutations(world_id,id,organism_id,source_round_id,template,provenance,remaining_hops,remaining_rounds,status,lifetime)
       values($1,$2,$3,$4,$5,$6,16,3,'active',$7)`,
      [
        world.worldId,
        id,
        seed.organismId,
        seed.roundId,
        { from: 'pulse', to: 'calm', amount: 2 },
        { supporters: 2, totalVotes: 5 },
        born,
      ],
    );
    const aged = consumeValidRound(born, randomUUID(), true);
    await pool.query(
      'update dormant_mutations set lifetime=$3,remaining_rounds=2,version=version+1 where world_id=$1 and id=$2',
      [world.worldId, id, aged],
    );
    await expect(
      pool.query(
        'update dormant_mutations set lifetime=$3,remaining_rounds=3,version=version+1 where world_id=$1 and id=$2',
        [world.worldId, id, born],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        "update dormant_mutations set provenance='{}',version=version+1 where world_id=$1 and id=$2",
        [world.worldId, id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        'update dormant_mutations set remaining_hops=15,version=version+1 where world_id=$1 and id=$2',
        [world.worldId, id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      "update dormant_mutations set status='expired',remaining_rounds=0,lifetime=$3,version=version+1 where world_id=$1 and id=$2",
      [world.worldId, id, { ...aged, remainingRounds: 0 }],
    );
    await expect(
      pool.query(
        "update dormant_mutations set status='active',version=version+1 where world_id=$1 and id=$2",
        [world.worldId, id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('allows one explicit trace activation allowance and freezes the original qualifying round', async () => {
    const { world, seed } = await seeded(),
      id = randomUUID();
    const born = newValidRoundLifetime(seed.roundId, 3),
      aged = consumeValidRound(born, randomUUID(), true);
    await pool.query(
      `insert into habitat_traces(world_id,id,channel_id,emitter_id,template,status,remaining_rounds,version,decision,provenance,lifetime,qualifying_round_id)
       values($1,$2,$3,$4,'shelter','pending',2,0,'{}','{}',$5,$6)`,
      [world.worldId, id, world.channelId, seed.organismId, aged, seed.roundId],
    );
    await pool.query(
      "update habitat_traces set status='active',remaining_rounds=3,lifetime=$3,version=version+1,decision=$4 where world_id=$1 and id=$2",
      [world.worldId, id, born, { choice: 'keep', votes: 4 }],
    );
    await pool.query(
      'update habitat_traces set remaining_rounds=2,lifetime=$3,version=version+1 where world_id=$1 and id=$2',
      [world.worldId, id, aged],
    );
    await expect(
      pool.query(
        'update habitat_traces set remaining_rounds=3,lifetime=$3,version=version+1 where world_id=$1 and id=$2',
        [world.worldId, id, born],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        "update habitat_traces set template='charged',version=version+1 where world_id=$1 and id=$2",
        [world.worldId, id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      "update habitat_traces set status='cleared',remaining_rounds=0,lifetime=$3,version=version+1 where world_id=$1 and id=$2",
      [world.worldId, id, { ...aged, remainingRounds: 0 }],
    );
    await expect(
      pool.query(
        "update habitat_traces set status='pending',version=version+1 where world_id=$1 and id=$2",
        [world.worldId, id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
