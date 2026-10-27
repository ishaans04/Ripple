import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { acceptInputInTransaction } from './intake.ts';
import { lockChannels, transaction } from './transaction.ts';

export interface DeadlineLease {
  world_id: string;
  channel_id: string;
  id: string;
  command: unknown;
  due_at: Date;
}
/** Locks jobs only while claiming. Channel locks are acquired in a separate transaction. */
export async function claimDeadlines(
  pool: pg.Pool,
  owner: string,
  limit = 32,
  leaseMs = 15_000,
): Promise<DeadlineLease[]> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 100 ||
    leaseMs > 60_000
  )
    throw new Error('Invalid deadline lease bounds.');
  return transaction(pool, async (client) => {
    const jobs = await client.query<DeadlineLease>(
      `select d.world_id,d.channel_id,d.id,d.command,d.due_at from deadlines d join worlds w on w.id=d.world_id
      where d.status in ('pending','leased') and (d.lease_until is null or d.lease_until<=clock_timestamp())
      and d.due_at <= coalesce(w.clock_at,clock_timestamp()) and w.mode<>'replay' and (w.expires_at is null or w.expires_at>clock_timestamp())
      order by d.due_at,d.world_id,d.id limit $1 for update of d skip locked`,
      [limit],
    );
    for (const job of jobs.rows)
      await client.query(
        `update deadlines set status='leased',lease_owner=$3,lease_until=clock_timestamp()+$4*interval '1 millisecond',attempts=attempts+1 where world_id=$1 and id=$2`,
        [job.world_id, job.id, owner, leaseMs],
      );
    return jobs.rows;
  });
}
export async function deliverDeadline(
  pool: pg.Pool,
  job: DeadlineLease,
  owner: string,
): Promise<boolean> {
  return transaction(pool, async (client) => {
    await lockChannels(client, job.world_id, [job.channel_id]);
    const leased = await client.query<{ command: unknown; mode: string; due_at: Date }>(
      `select d.command,w.mode,d.due_at from deadlines d join worlds w on w.id=d.world_id
      where d.world_id=$1 and d.id=$2 and d.status='leased' and d.lease_owner=$3 and d.lease_until>clock_timestamp() for update of d`,
      [job.world_id, job.id, owner],
    );
    const row = leased.rows[0];
    if (row === undefined) return false;
    await acceptInputInTransaction(client, {
      worldId: job.world_id,
      channelId: job.channel_id,
      provider: 'deadline',
      messageId: job.id,
      command: row.command,
      ...(row.mode === 'live' ? {} : { acceptedAtMs: row.due_at.getTime() }),
    });
    await client.query(
      `update deadlines set status='delivered',lease_owner=null,lease_until=null where world_id=$1 and id=$2`,
      [job.world_id, job.id],
    );
    return true;
  });
}
export async function scanDeadlines(pool: pg.Pool, owner = randomUUID()): Promise<number> {
  const jobs = await claimDeadlines(pool, owner);
  let delivered = 0;
  for (const job of jobs) if (await deliverDeadline(pool, job, owner)) delivered++;
  return delivered;
}
