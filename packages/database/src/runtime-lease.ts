import type pg from 'pg';
import { transaction } from './transaction.ts';

export async function acquireRuntimeLease(
  pool: pg.Pool,
  owner: string,
): Promise<{ acquired: boolean; takeover: boolean }> {
  return transaction(pool, async (client) => {
    // The fixed advisory lock also serializes the first insert, before a lease row exists.
    await client.query('select pg_advisory_xact_lock(5927049098331875656)');
    const previous = (
      await client.query<{ owner: string; expired: boolean }>(
        `select owner,lease_until<=clock_timestamp() as expired from runtime_leases where name='game' for update`,
      )
    ).rows[0];
    if (previous !== undefined && previous.owner !== owner && !previous.expired)
      return { acquired: false, takeover: false };
    const takeover = previous?.owner !== owner || previous.expired;
    await client.query(
      `insert into runtime_leases (name,owner,fence,lease_until) values ('game',$1,1,clock_timestamp()+interval '5 seconds')
      on conflict (name) do update set owner=$1,fence=runtime_leases.fence+case when runtime_leases.owner<>$1 then 1 else 0 end,lease_until=clock_timestamp()+interval '5 seconds'`,
      [owner],
    );
    return { acquired: true, takeover };
  });
}
export async function releaseRuntimeLease(pool: pg.Pool, owner: string): Promise<void> {
  await pool.query(
    `update runtime_leases set lease_until=clock_timestamp() where name='game' and owner=$1`,
    [owner],
  );
}
