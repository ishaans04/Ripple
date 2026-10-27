import type pg from 'pg';

export function postgresCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
/** Retry only transactions PostgreSQL guarantees did not commit. No external effects inside. */
export async function transaction<T>(
  pool: pg.Pool,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      if (attempt >= 2 || !['40001', '40P01'].includes(postgresCode(error) ?? '')) throw error;
    } finally {
      client.release();
    }
  }
}

/** Every multi-channel state writer must acquire these locks in the same order. */
export async function lockChannels(
  client: pg.PoolClient,
  worldId: string,
  channelIds: readonly string[],
): Promise<void> {
  for (const id of [...new Set(channelIds)].sort()) {
    const result = await client.query(
      'select id from channels where world_id=$1 and id=$2 for update',
      [worldId, id],
    );
    if (result.rowCount !== 1) throw new Error('Channel does not exist in this world.');
  }
}
