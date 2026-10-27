import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.ts';
import { acceptInput } from '../intake.ts';
import { createTemporaryDatabase, createTestChannel, type TemporaryDatabase } from '../testing.ts';

describe('accepted history and genealogy guards', () => {
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
  it('freezes channel genesis, world rules and accepted command contents while allowing retry metadata', async () => {
    const scope = await createTestChannel(pool);
    await acceptInput(pool, {
      ...scope,
      provider: 'test',
      messageId: 'receipt',
      command: { type: 'resume' },
    });
    await expect(
      pool.query('update channels set seed=$3 where world_id=$1 and id=$2', [
        scope.worldId,
        scope.channelId,
        'changed',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('update channels set initial_online=true where world_id=$1 and id=$2', [
        scope.worldId,
        scope.channelId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('update worlds set rules_hash=$2 where id=$1', [scope.worldId, 'f'.repeat(64)]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('update inbox set command=$3 where world_id=$1 and channel_id=$2', [
        scope.worldId,
        scope.channelId,
        '{"type":"pause","reason":"manual"}',
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      'update inbox set attempts=attempts+1,error_code=$3 where world_id=$1 and channel_id=$2',
      [scope.worldId, scope.channelId, 'PROCESSING_FAILED'],
    );
    await pool.query('update channels set processed_sequence=1 where world_id=$1 and id=$2', [
      scope.worldId,
      scope.channelId,
    ]);
    await expect(
      pool.query('update channels set processed_sequence=0 where world_id=$1 and id=$2', [
        scope.worldId,
        scope.channelId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('enforces founding snapshots and the immediate parent generation and lineage', async () => {
    const scope = await createTestChannel(pool),
      lineage = randomUUID(),
      founder = randomUUID();
    await pool.query(
      'insert into lineages (world_id,id,origin_channel_id,rules_hash) select world_id,$3,id,rules_hash from channels where world_id=$1 and id=$2',
      [scope.worldId, scope.channelId, lineage],
    );
    const insert = async (
      id: string,
      parent: string | null,
      generation: number,
      genome = '{"pulse":6,"calm":6,"grit":6,"drift":6}',
    ) =>
      pool.query(
        `insert into organisms (world_id,id,lineage_id,parent_id,founder_id,generation,founding_genome,pulse,calm,grit,drift,health,status,appearance,mutation_slots) values ($1,$2,$3,$4,$5,$6,$7,6,6,6,6,70,'ALIVE','{}','{}')`,
        [scope.worldId, id, lineage, parent, founder, generation, genome],
      );
    await insert(founder, null, 0);
    await expect(insert(randomUUID(), founder, 2)).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert(randomUUID(), founder, 1, '{"pulse":4,"calm":8,"grit":6,"drift":6}'),
    ).rejects.toMatchObject({ code: '23514' });
    await insert(randomUUID(), founder, 1);
    await expect(
      pool.query('update organisms set health=0 where world_id=$1 and id=$2', [
        scope.worldId,
        founder,
      ]),
    ).rejects.toMatchObject({ constraint: 'organisms_living_health' });
    await pool.query(`update organisms set health=0,status='FOSSIL' where world_id=$1 and id=$2`, [
      scope.worldId,
      founder,
    ]);
    await expect(insert(randomUUID(), founder, 1)).rejects.toMatchObject({ code: '23514' });
  });
  it('makes committed audit events and public projections append-only', async () => {
    const scope = await createTestChannel(pool);
    await acceptInput(pool, {
      ...scope,
      provider: 'test',
      messageId: 'immutable',
      command: { type: 'resume' },
    });
    await pool.query(
      `insert into game_events (world_id,channel_id,sequence,id,operation_id,engine_version,rules_hash,accepted_at,command,result,dependencies,previous_checksum,checksum)
      select i.world_id,i.channel_id,i.sequence,$3,'test:immutable',1,c.rules_hash,i.accepted_at,i.command,'{}','[]',$4,$4 from inbox i join channels c on c.world_id=i.world_id and c.id=i.channel_id where i.world_id=$1 and i.channel_id=$2`,
      [scope.worldId, scope.channelId, randomUUID(), '0'.repeat(64)],
    );
    await pool.query(
      `insert into public_updates (world_id,channel_id,version,event_id,type,payload) values ($1,$2,1,$3,'snapshot','{}')`,
      [scope.worldId, scope.channelId, randomUUID()],
    );
    await expect(
      pool.query(`update game_events set result='{"changed":true}' where world_id=$1`, [
        scope.worldId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(`update public_updates set payload='{"changed":true}' where world_id=$1`, [
        scope.worldId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
