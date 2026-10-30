import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimDeadlines, deliverDeadline, scanDeadlines } from './deadlines.ts';
import { runMigrations } from './migrate.ts';
import { createTemporaryDatabase, createTestChannel, type TemporaryDatabase } from './testing.ts';

describe('leased durable deadlines', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
  });
  beforeEach(async () => {
    await pool.query('delete from deadlines');
  });
  afterAll(async () => {
    await pool.end();
    await temporary.drop();
  });
  async function jobs(count: number): Promise<void> {
    const scope = await createTestChannel(pool, 'sandbox');
    for (let i = 0; i < count; i++)
      await pool.query(
        `insert into deadlines (world_id,channel_id,id,job_key,command,due_at,remaining_ms) values ($1,$2,$3,$4,$5,now()-interval '1 second',0)`,
        [scope.worldId, scope.channelId, randomUUID(), `job-${i}`, '{"type":"resume"}'],
      );
  }
  it('claims disjoint batches across concurrent scanners', async () => {
    await jobs(12);
    const batches = await Promise.all([
      claimDeadlines(pool, randomUUID(), 6),
      claimDeadlines(pool, randomUUID(), 6),
    ]);
    expect(batches.flat()).toHaveLength(12);
    expect(new Set(batches.flat().map((j) => j.id)).size).toBe(12);
  });
  it('reclaims an expired lease and fences its former owner', async () => {
    await jobs(1);
    const firstOwner = randomUUID(),
      secondOwner = randomUUID();
    const first = (await claimDeadlines(pool, firstOwner))[0]!;
    await pool.query(`update deadlines set lease_until=now()-interval '1 second'`);
    const second = (await claimDeadlines(pool, secondOwner))[0]!;
    expect(second.id).toBe(first.id);
    expect(await deliverDeadline(pool, first, firstOwner)).toBe(false);
    expect(await deliverDeadline(pool, second, secondOwner)).toBe(true);
    expect(await deliverDeadline(pool, second, secondOwner)).toBe(false);
    expect((await pool.query('select * from inbox')).rowCount).toBe(1);
    expect(
      (await pool.query<{ attempts: number }>('select attempts from deadlines')).rows[0]?.attempts,
    ).toBe(2);
  });
  it('does not dispatch a job cancelled while its lease was outstanding', async () => {
    await jobs(1);
    const owner = randomUUID();
    const job = (await claimDeadlines(pool, owner))[0]!;
    await pool.query(`update deadlines set status='cancelled'`);
    expect(await deliverDeadline(pool, job, owner)).toBe(false);
    expect(await claimDeadlines(pool, randomUUID())).toEqual([]);
  });
  it('dispatches a cohort across channels while preserving each channel order and unique receipts', async () => {
    const scopes = [];
    for (let channel = 0; channel < 8; channel++) {
      const scope = await createTestChannel(pool, 'sandbox');
      scopes.push(scope);
      for (let step = 0; step < 4; step++)
        await pool.query(
          `insert into deadlines(world_id,channel_id,id,job_key,command,due_at,remaining_ms)
          select $1,$2,$3,$4,$5,coalesce(clock_at,clock_timestamp())-interval '1 second'+$6*interval '1 millisecond',0 from worlds where id=$1`,
          [
            scope.worldId,
            scope.channelId,
            randomUUID(),
            `cohort-${step}`,
            JSON.stringify({ type: 'activity', actorKey: String(step) }),
            step,
          ],
        );
    }
    expect(await scanDeadlines(pool)).toBe(32);
    expect(await scanDeadlines(pool)).toBe(0);
    for (const scope of scopes) {
      const rows = await pool.query<{ sequence: number; command: { actorKey: string } }>(
        'select sequence,command from inbox where world_id=$1 and channel_id=$2 order by sequence',
        [scope.worldId, scope.channelId],
      );
      expect(rows.rows.map((row) => [row.sequence, row.command.actorKey])).toEqual([
        [1, '0'],
        [2, '1'],
        [3, '2'],
        [4, '3'],
      ]);
    }
  });
});
