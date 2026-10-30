import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.ts';
import { createTemporaryDatabase, type TemporaryDatabase } from '../testing.ts';

describe('game identity invariants in PostgreSQL', () => {
  let temporary: TemporaryDatabase;
  let pool: pg.Pool;
  const world = randomUUID();
  const otherWorld = randomUUID();
  const channel = randomUUID();
  const lineage = randomUUID();
  const organism = randomUUID();
  const hash = 'c'.repeat(64);

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    await pool.query(
      'insert into rulesets (hash, version, engine_version, canonical) values ($1, $2, 1, $3)',
      [hash, 'test-1', '{}'],
    );
    for (const id of [world, otherWorld]) {
      await pool.query('insert into worlds (id, mode, rules_hash) values ($1, $2, $3)', [
        id,
        'replay',
        hash,
      ]);
      await pool.query(
        'insert into channels (world_id,id,label,rules_hash,seed,configuration) values ($1,$2,$3,$4,$5,$6)',
        [id, channel, 'test', hash, 'seed', '{}'],
      );
      await pool.query(
        'insert into lineages (world_id,id,origin_channel_id,rules_hash) values ($1,$2,$3,$4)',
        [id, lineage, channel, hash],
      );
    }
    await pool.query(
      `insert into organisms (world_id,id,lineage_id,founder_id,generation,founding_genome,pulse,calm,grit,drift,health,status,appearance,mutation_slots)
      values ($1,$2,$3,$2,0,$4,6,6,6,6,70,'ALIVE',$5,$5)`,
      [world, organism, lineage, '{"pulse":6,"calm":6,"grit":6,"drift":6}', '{}'],
    );
  });
  afterAll(async () => {
    await pool.end();
    await temporary.drop();
  });

  it('enforces integer gene bounds and the conserved budget', async () => {
    for (const [pulse, calm] of [
      [7, 6],
      [16, -4],
    ]) {
      await expect(
        pool.query('update organisms set pulse=$1,calm=$2 where world_id=$3 and id=$4', [
          pulse,
          calm,
          world,
          organism,
        ]),
      ).rejects.toMatchObject({ constraint: 'organisms_genome_legal' });
    }
    await expect(
      pool.query('update organisms set health=101 where world_id=$1 and id=$2', [world, organism]),
    ).rejects.toMatchObject({ constraint: 'organisms_health_bounds' });
  });

  it('rejects a residency that refers to an organism in another world', async () => {
    await expect(
      pool.query(
        `insert into residencies (world_id,id,channel_id,organism_id,role) values ($1,$2,$3,$4,'resident')`,
        [otherWorld, randomUUID(), channel, organism],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('permits one active resident and retains ended history', async () => {
    const id = randomUUID();
    await pool.query(
      `insert into residencies (world_id,id,channel_id,organism_id,role) values ($1,$2,$3,$4,'resident')`,
      [world, id, channel, organism],
    );
    await expect(
      pool.query(
        `insert into residencies (world_id,id,channel_id,organism_id,role) values ($1,$2,$3,$4,'visitor')`,
        [world, randomUUID(), channel, organism],
      ),
    ).rejects.toMatchObject({ constraint: 'residencies_active_organism' });
    await pool.query('update residencies set ended_at=now() where world_id=$1 and id=$2', [
      world,
      id,
    ]);
    await pool.query(
      `insert into residencies (world_id,id,channel_id,organism_id,role) values ($1,$2,$3,$4,'resident')`,
      [world, randomUUID(), channel, organism],
    );
  });

  it('keeps rules and genetic ancestry immutable', async () => {
    await expect(
      pool.query('update rulesets set canonical=$1 where hash=$2', ['{"changed":true}', hash]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('delete from rulesets where hash=$1', [hash])).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      pool.query('update organisms set founding_genome=$1 where world_id=$2 and id=$3', [
        '{}',
        world,
        organism,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('records the appearance mapping version once and rejects unknown or rewritten versions', async () => {
    const saved = await pool.query<{ appearance_mapping: number }>(
      'select appearance_mapping from organisms where world_id=$1 and id=$2',
      [world, organism],
    );
    expect(saved.rows[0]?.appearance_mapping).toBe(1);
    await expect(
      pool.query('update organisms set appearance_mapping=2 where world_id=$1 and id=$2', [
        world,
        organism,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const unknown = randomUUID();
    await expect(
      pool.query(
        `insert into organisms (world_id,id,lineage_id,founder_id,generation,founding_genome,pulse,calm,grit,drift,health,status,appearance,mutation_slots,appearance_mapping)
         values ($1,$2,$3,$2,0,$4,6,6,6,6,50,'ALIVE','{}','[]',2)`,
        [world, unknown, lineage, '{"pulse":6,"calm":6,"grit":6,"drift":6}'],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
