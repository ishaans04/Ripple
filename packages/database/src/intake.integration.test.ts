import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptInput, acceptInputInTransaction } from './intake.ts';
import { runMigrations } from './migrate.ts';
import { createTemporaryDatabase, createTestChannel, type TemporaryDatabase } from './testing.ts';
import { transaction } from './transaction.ts';

describe('durable ordered intake', () => {
  let temporary: TemporaryDatabase;
  let pool: pg.Pool;
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
    await temporary.drop();
  });
  it('accepts concurrent duplicate receipts once and allocates no sequence gaps', async () => {
    const scope = await createTestChannel(pool);
    const input = {
      ...scope,
      provider: 'synthetic',
      messageId: 'one',
      command: { type: 'activity', actorKey: 'a' },
    };
    const receipts = await Promise.all(Array.from({ length: 20 }, () => acceptInput(pool, input)));
    expect(receipts.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(receipts.every((r) => r.sequence === 1)).toBe(true);
    const next = await acceptInput(pool, { ...input, messageId: 'two' });
    expect(next.sequence).toBe(2);
    await expect(
      acceptInput(pool, { ...input, command: { type: 'activity', actorKey: 'b' } }),
    ).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' });
  });
  it('rolls back the receipt and cursor together when persistence fails', async () => {
    const scope = await createTestChannel(pool);
    const input = {
      ...scope,
      provider: 'synthetic',
      messageId: 'rollback',
      command: { type: 'resume' },
    };
    await expect(
      transaction(pool, async (client) => {
        await acceptInputInTransaction(client, input);
        throw new Error('transaction failed');
      }),
    ).rejects.toThrow('transaction failed');
    expect(await acceptInput(pool, input)).toMatchObject({ sequence: 1, duplicate: false });
  });
  it('cannot inject a synthetic timestamp or synthetic command into a live world', async () => {
    const scope = await createTestChannel(pool, 'live');
    const input = {
      ...scope,
      provider: 'synthetic',
      messageId: 'wrong-world',
      command: { type: 'resume' },
    };
    await expect(acceptInput(pool, { ...input, requiredMode: 'sandbox' })).rejects.toMatchObject({
      code: 'WRONG_WORLD_MODE',
    });
    await expect(acceptInput(pool, { ...input, acceptedAtMs: 0 })).rejects.toMatchObject({
      code: 'WRONG_WORLD_MODE',
    });
  });
  it('never moves acceptance time backwards when requests race a synthetic clock', async () => {
    const scope = await createTestChannel(pool);
    const input = { ...scope, provider: 'synthetic', command: { type: 'resume' } };
    await acceptInput(pool, { ...input, messageId: 'later', acceptedAtMs: 2000 });
    expect(
      await acceptInput(pool, { ...input, messageId: 'earlier', acceptedAtMs: 1000 }),
    ).toMatchObject({ acceptedAtMs: 2000, sequence: 2 });
  });
  it('returns a stable conflict when the same world-wide receipt races across channels', async () => {
    const scope = await createTestChannel(pool),
      second = randomUUID();
    await pool.query(
      'insert into channels (world_id,id,label,rules_hash,seed,configuration) select world_id,$3,label,rules_hash,seed,configuration from channels where world_id=$1 and id=$2',
      [scope.worldId, scope.channelId, second],
    );
    const input = {
      ...scope,
      provider: 'synthetic',
      messageId: 'cross-channel',
      command: { type: 'resume' },
    };
    const results = await Promise.allSettled([
      acceptInput(pool, input),
      acceptInput(pool, { ...input, channelId: second }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toMatchObject({
      code: 'RECEIPT_CONFLICT',
    });
    expect(
      (
        await pool.query<{ total: string }>(
          'select sum(intake_sequence) as total from channels where world_id=$1',
          [scope.worldId],
        )
      ).rows[0]?.total,
    ).toBe('1');
    expect(
      (await pool.query('select * from inbox where world_id=$1', [scope.worldId])).rowCount,
    ).toBe(1);
  });
});
