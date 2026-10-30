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
    let connectionFailure: Error | undefined;
    const failedConnection = (error: Error) => {
      connectionFailure = error;
    };
    // Pool error handlers cover idle clients only. An active backend can also disconnect.
    client.on('error', failedConnection);
    try {
      await client.query('begin');
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch((rollbackError: unknown) => {
        connectionFailure =
          rollbackError instanceof Error ? rollbackError : new Error('Rollback connection failed');
      });
      if (attempt >= 2 || !['40001', '40P01'].includes(postgresCode(error) ?? '')) throw error;
    } finally {
      client.release(connectionFailure);
      client.off('error', failedConnection);
    }
  }
}

/** Every multi-channel state writer must acquire these locks in the same order. */
export async function lockChannels(
  client: pg.PoolClient,
  worldId: string,
  channelIds: readonly string[],
): Promise<void> {
  // PostgreSQL UUID equality ignores case. Lock ordering and deduplication must do the same.
  for (const id of [...new Set(channelIds.map((value) => value.toLowerCase()))].sort()) {
    const result = await client.query(
      'select id from channels where world_id=$1 and id=$2 for update',
      [worldId, id],
    );
    if (result.rowCount !== 1) throw new Error('Channel does not exist in this world.');
  }
}
