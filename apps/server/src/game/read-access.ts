import { randomBytes } from 'node:crypto';
import { transaction } from '@ripple/database';
import { sha256Hex } from '@ripple/engine';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import type { WorldScope } from './sandbox.ts';

export function bearer(header: string | undefined): string {
  const token = /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(header ?? '')?.[1];
  if (token === undefined)
    throw new ApiError('UNAUTHORIZED', 401, 'A read capability is required.');
  return token;
}
export async function authorizeRead(
  pool: pg.Pool,
  scope: WorldScope,
  capability: string,
): Promise<void> {
  return authorizeReadHash(pool, scope, sha256Hex(capability));
}
export async function authorizeReadHash(
  pool: pg.Pool,
  scope: WorldScope,
  hash: string,
): Promise<void> {
  const result = await pool.query(
    `select c.id from channels c join worlds w on w.id=c.world_id where c.world_id=$1 and c.id=$2
    and (w.expires_at is null or w.expires_at>clock_timestamp()) and
    (exists(select 1 from overlay_capabilities o where o.world_id=c.world_id and o.channel_id=c.id and o.hash=$3 and o.revoked_at is null)
    or (w.mode='sandbox' and w.owner_capability_hash=$3))`,
    [scope.worldId, scope.channelId, hash],
  );
  if (result.rowCount !== 1)
    throw new ApiError('UNAUTHORIZED', 401, 'Read access is invalid or expired.');
}
export async function exchangeReadCapability(
  pool: pg.Pool,
  scope: WorldScope,
  capability: string,
): Promise<{ ticket: string; expiresAt: string }> {
  await authorizeRead(pool, scope, capability);
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = await transaction(pool, async (client) => {
    // Serialize outstanding-ticket limits per topic without exposing its capability.
    await client.query('select id from channels where world_id=$1 and id=$2 for update', [
      scope.worldId,
      scope.channelId,
    ]);
    await client.query('delete from gateway_tickets where expires_at<=clock_timestamp()');
    const count = (
      await client.query<{ count: string }>(
        'select count(*) from gateway_tickets where world_id=$1 and channel_id=$2',
        [scope.worldId, scope.channelId],
      )
    ).rows[0]?.count;
    if (Number(count) >= 32)
      throw new ApiError('CAPACITY_FULL', 429, 'Too many outstanding connection tickets.');
    const row = (
      await client.query<{ expires_at: Date }>(
        `insert into gateway_tickets (hash,world_id,channel_id,expires_at,authority_hash) values ($1,$2,$3,clock_timestamp()+interval '30 seconds',$4) returning expires_at`,
        [sha256Hex(ticket), scope.worldId, scope.channelId, sha256Hex(capability)],
      )
    ).rows[0];
    if (row === undefined) throw new Error('Could not persist a gateway ticket.');
    return row.expires_at.toISOString();
  });
  return { ticket, expiresAt };
}
export async function consumeReadTicket(
  pool: pg.Pool,
  ticket: string,
): Promise<WorldScope & { authorityHash: string }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket))
    throw new ApiError('UNAUTHORIZED', 401, 'Connection ticket is invalid.');
  const row = (
    await pool.query<{ world_id: string; channel_id: string; authority_hash: string }>(
      `delete from gateway_tickets t using worlds w where t.world_id=w.id and t.hash=$1
    and t.expires_at>clock_timestamp() and (w.expires_at is null or w.expires_at>clock_timestamp()) returning t.world_id,t.channel_id,t.authority_hash`,
      [sha256Hex(ticket)],
    )
  ).rows[0];
  if (row === undefined)
    throw new ApiError('UNAUTHORIZED', 401, 'Connection ticket was used or expired.');
  const scope = { worldId: row.world_id, channelId: row.channel_id };
  await authorizeReadHash(pool, scope, row.authority_hash);
  return { ...scope, authorityHash: row.authority_hash };
}
