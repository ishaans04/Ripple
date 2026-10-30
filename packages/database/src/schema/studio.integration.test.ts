import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate.ts';
import { createTemporaryDatabase, type TemporaryDatabase } from '../testing.ts';

const hash = (n: number) => n.toString(16).padStart(64, '0');
const founder = {
  kind: 'founder',
  rendererVersion: 'shell-v1',
  part: {
    type: 'shell',
    templateId: 'segmented-shell',
    parameters: { width: 620, height: 440, curvature: 300 },
    marking: { patternId: 'plain', paletteId: 'teal-amber' },
  },
};

describe('studio storage', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  const world = randomUUID(),
    channel = randomUUID(),
    lineage = randomUUID(),
    organism = randomUUID(),
    rules = hash(1);
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    await pool.query(
      "insert into rulesets(hash,version,engine_version,canonical) values($1,'candidate-1',1,'{}')",
      [rules],
    );
    await pool.query(
      "insert into worlds(id,mode,rules_hash,owner_capability_hash,expires_at) values($1,'sandbox',$2,repeat('a',64),clock_timestamp()+interval '1 day')",
      [world, rules],
    );
    await pool.query(
      `insert into channels(world_id,id,label,rules_hash,seed,configuration) values($1,$2,'Studio storage',$3,'seed','{}')`,
      [world, channel, rules],
    );
    await pool.query(
      'insert into lineages(world_id,id,origin_channel_id,rules_hash) values($1,$2,$3,$4)',
      [world, lineage, channel, rules],
    );
    await pool.query(
      `insert into organisms(world_id,id,lineage_id,founder_id,generation,founding_genome,pulse,calm,grit,drift,health,status,appearance,mutation_slots)
       values($1,$2,$3,$2,0,'{"pulse":6,"calm":6,"grit":6,"drift":6}',6,6,6,6,70,'ALIVE',$4,'{}')`,
      [world, organism, lineage, JSON.stringify(founder)],
    );
  });
  afterAll(async () => {
    await pool.end();
    await temporary.drop();
  });
  async function session(phase = 'CREATING') {
    const id = randomUUID();
    await pool.query(
      `insert into studio_sessions(world_id,id,channel_id,organism_id,phase,trigger,challenge,seed,settings,opened_sequence,created_at,ended_at)
       values($1,$2,$3,$4,$5,'manual','{}','seed','{}',1,clock_timestamp(),case when $5 in ('COMPLETED','CANCELLED','EXPIRED') then clock_timestamp() end)`,
      [world, id, channel, organism, phase],
    );
    return id;
  }
  async function blueprint(n: number, sessionId: string) {
    await pool.query(
      `insert into appearance_blueprints(world_id,hash,canonical,blueprint,renderer_version,template,session_id) values($1,$2,'{}','{}','shell-v1','cosmetic-only',$3)`,
      [world, hash(n), sessionId],
    );
    return hash(n);
  }
  it('initializes disabled studio settings for every channel', async () => {
    const row = (
      await pool.query<{ settings: { enabled: boolean }; availability: string }>(
        'select settings,availability from channel_studio where world_id=$1 and channel_id=$2',
        [world, channel],
      )
    ).rows[0];
    expect(row).toMatchObject({ settings: { enabled: false }, availability: 'ACTIVE' });
  });
  it('allows one nonterminal studio per channel and freezes terminal sessions', async () => {
    const first = await session();
    await expect(session()).rejects.toThrow(/studio_one_nonterminal_per_channel/);
    await pool.query(
      "update studio_sessions set phase='CANCELLED',version=1,ended_at=clock_timestamp() where world_id=$1 and id=$2",
      [world, first],
    );
    await expect(
      pool.query(
        "update studio_sessions set phase='VOTING',version=2,ended_at=null where world_id=$1 and id=$2",
        [world, first],
      ),
    ).rejects.toThrow(/terminal studio sessions are immutable/);
    const second = await session();
    await expect(
      pool.query(
        'update studio_sessions set challenge=\'{"x":1}\' ,version=1 where world_id=$1 and id=$2',
        [world, second],
      ),
    ).rejects.toThrow(/captured studio challenge is immutable/);
    await expect(
      pool.query("update studio_sessions set phase='VOTING' where world_id=$1 and id=$2", [
        world,
        second,
      ]),
    ).rejects.toThrow(/advance its version/);
    await pool.query(
      "update studio_sessions set phase='CANCELLED',version=1,ended_at=clock_timestamp() where world_id=$1 and id=$2",
      [world, second],
    );
  });
  it('keeps one active proposal per artist, immutable content and immutable blueprints', async () => {
    const id = await session();
    const design = await blueprint(10, id);
    const insert = (proposal: string) =>
      pool.query(
        `insert into studio_proposals(world_id,id,session_id,artist_key,credit,credit_opt_in,revision,blueprint_hash,status,submitted_sequence,submitted_at)
         values($1,$2,$3,$4,'Channel',false,1,$5,'active',1,clock_timestamp())`,
        [world, proposal, id, hash(99), design],
      );
    const proposal = randomUUID();
    await insert(proposal);
    await expect(insert(randomUUID())).rejects.toThrow(/studio_one_active_proposal_per_artist/);
    await expect(
      pool.query('update studio_proposals set credit_opt_in=true where world_id=$1 and id=$2', [
        world,
        proposal,
      ]),
    ).rejects.toThrow(/immutable/);
    await pool.query("update studio_proposals set status='withdrawn' where world_id=$1 and id=$2", [
      world,
      proposal,
    ]);
    await expect(
      pool.query("update studio_proposals set status='active' where world_id=$1 and id=$2", [
        world,
        proposal,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(
        'update appearance_blueprints set canonical=\'{"x":2}\' where world_id=$1 and hash=$2',
        [world, design],
      ),
    ).rejects.toThrow(/append-only/);
    await pool.query(
      "update studio_sessions set phase='CANCELLED',version=1,ended_at=clock_timestamp() where world_id=$1 and id=$2",
      [world, id],
    );
  });
  it('allows one pending adaptation per organism and one commitment per slot', async () => {
    const first = await session('PENDING_HATCH');
    const design = await blueprint(20, first);
    const adaptation = (sessionId: string, status = 'pending') =>
      pool.query(
        `insert into pending_adaptations(world_id,id,session_id,channel_id,organism_id,blueprint_hash,template,target_slot,status,approval,created_at)
         values($1,$2,$3,$4,$5,$6,'cosmetic-only',3,$7,'{}',clock_timestamp())`,
        [world, randomUUID(), sessionId, channel, organism, design, status],
      );
    await adaptation(first);
    await pool.query(
      "update studio_sessions set phase='COMPLETED',version=1,ended_at=clock_timestamp() where world_id=$1 and id=$2",
      [world, first],
    );
    const second = await session('PENDING_HATCH');
    await expect(adaptation(second)).rejects.toThrow(/pending_adaptation_one_per_organism/);
    await pool.query(
      "update pending_adaptations set status='committed',resolved_at=clock_timestamp() where world_id=$1 and session_id=$2",
      [world, first],
    );
    await expect(adaptation(second, 'committed')).rejects.toThrow(
      /pending_adaptation_one_commit_per_slot/,
    );
    await expect(
      pool.query(
        "update pending_adaptations set status='released' where world_id=$1 and session_id=$2",
        [world, first],
      ),
    ).rejects.toThrow(/immutable/);
  });
  it('binds a studio appearance to its stored blueprint hash', async () => {
    await expect(
      pool.query(`update organisms set appearance_hash=$3 where world_id=$1 and id=$2`, [
        world,
        organism,
        hash(20),
      ]),
    ).rejects.toThrow(/organisms_appearance_matches_hash/);
    await pool.query(
      `update organisms set appearance=jsonb_build_object('kind','studio','hash',$3::text),appearance_hash=$3 where world_id=$1 and id=$2`,
      [world, organism, hash(20)],
    );
    await expect(
      pool.query(
        `update organisms set appearance=jsonb_build_object('kind','studio','hash',$3::text),appearance_hash=$3 where world_id=$1 and id=$2`,
        [world, organism, hash(77)],
      ),
    ).rejects.toThrow(/organisms_appearance_blueprint_fk/);
  });
  it('lets a studio ballot coexist only with the paused ordinary round', async () => {
    const round = (kind: string) =>
      pool.query(
        `insert into rounds(world_id,id,channel_id,organism_id,number,kind,phase,rules_hash,seed,checkpoint,opened_at)
         values($1,$2,$3,$4,(select coalesce(max(number),0)+1 from rounds where world_id=$1),$5,'VOTING',$6,'seed','{}',clock_timestamp())`,
        [world, randomUUID(), channel, organism, kind, rules],
      );
    await round('MUTATION');
    await round('STUDIO_SELECTION');
    await expect(round('WELCOME')).rejects.toThrow(/rounds_one_open/);
    await expect(round('STUDIO_SELECTION')).rejects.toThrow(/rounds_one_open_studio/);
  });
});
