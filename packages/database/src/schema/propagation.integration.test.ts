import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.ts';
import { createTemporaryDatabase, createTestChannel, type TemporaryDatabase } from '../testing.ts';

describe('ordered propagation records', () => {
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
  it('initializes versioned world policy and channel preparation without changing game genesis', async () => {
    const scope = await createTestChannel(pool);
    expect(
      (
        await pool.query<{
          preparation: string;
          preparation_requested: boolean;
          non_mutation_rounds: number;
        }>(
          'select preparation,preparation_requested,non_mutation_rounds from channel_play where world_id=$1',
          [scope.worldId],
        )
      ).rows,
    ).toEqual([{ preparation: 'neutral', preparation_requested: false, non_mutation_rounds: 0 }]);
    const policies = await pool.query<{ version: string; hash: string }>(
      'select p.version,p.hash from world_raid_policies w join raid_policies p on p.hash=w.policy_hash where w.world_id=$1',
      [scope.worldId],
    );
    expect(policies.rows[0]?.version).toBe('raid-policy-1');
    await expect(
      pool.query('update world_raid_policies set policy_hash=policy_hash where world_id=$1', [
        scope.worldId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query("insert into raid_policies(hash,version,canonical) values($1,'forged','{}')", [
        '0'.repeat(64),
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('records an absent source without inventing a parent and freezes transfer origin and ordered receipt', async () => {
    const a = await createTestChannel(pool),
      b = await createTestChannel(pool),
      transferId = randomUUID();
    await pool.query(
      "insert into transfers(world_id,id,receipt_id,source_channel_id,destination_twitch_id,source_version,outcome,snapshot) values($1,$2,'raid-no-parent',$3,'999',0,'SOURCE_INELIGIBLE','{}')",
      [a.worldId, transferId, a.channelId],
    );
    await expect(
      pool.query('update transfers set snapshot=\'{"changed":true}\' where world_id=$1 and id=$2', [
        a.worldId,
        transferId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query('update transfers set destination_sequence=3 where world_id=$1 and id=$2', [
      a.worldId,
      transferId,
    ]);
    await expect(
      pool.query('update transfers set destination_sequence=4 where world_id=$1 and id=$2', [
        a.worldId,
        transferId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query("update transfers set outcome='EXPIRED' where world_id=$1 and id=$2", [
        a.worldId,
        transferId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        "insert into transfer_transitions(world_id,transfer_id,version,outcome,at,channel_id,sequence,detail) values($1,$2,0,'SOURCE_INELIGIBLE',clock_timestamp(),$3,1,'{}')",
        [b.worldId, transferId, b.channelId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
