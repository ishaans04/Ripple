import { createHmac } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { transaction } from '@ripple/database';
import { sha256Hex } from '@ripple/engine';
import { authorizeSynthetic, SandboxError, type WorldScope } from './sandbox.ts';

/** One owner can create at most eight channels in an expiring sandbox world. */
export async function createSyntheticPeer(
  pool: pg.Pool,
  scope: WorldScope,
  owner: string,
  channelId: string,
  name: string,
): Promise<WorldScope & { readCapability: string; duplicate: boolean }> {
  z.uuid().parse(channelId);
  const label = `Synthetic ${z.string().trim().min(1).max(64).parse(name)}`;
  const readCapability = createHmac('sha256', owner)
    .update(`sandbox-read:${scope.worldId}:${channelId}`)
    .digest('base64url');
  const duplicate = await transaction(pool, async (client) => {
    await authorizeSynthetic(client, scope, owner);
    const existing = (
      await client.query<{ label: string; peer: boolean }>(
        'select label,exists(select 1 from overlay_capabilities where world_id=$1 and channel_id=$2 and hash=$3 and revoked_at is null) as peer from channels where world_id=$1 and id=$2',
        [scope.worldId, channelId, sha256Hex(readCapability)],
      )
    ).rows[0];
    if (existing !== undefined) {
      if (existing.label !== label || !existing.peer)
        throw new Error('Peer identifier was already used for a different channel.');
      return true;
    }
    const counted = (
      await client.query<{ count: number }>(
        'select count(*)::int as count from channels where world_id=$1',
        [scope.worldId],
      )
    ).rows[0];
    if (counted === undefined) throw new Error('Cannot count sandbox channels.');
    if (counted.count >= 8) throw new SandboxError('CAPACITY_FULL');
    await client.query(
      `insert into channels(world_id,id,label,rules_hash,seed,configuration,online,healthy,initial_online,initial_healthy)
      select world_id,$3,$4,rules_hash,$5,configuration,true,true,true,true from channels where world_id=$1 and id=$2`,
      [scope.worldId, scope.channelId, channelId, label, sha256Hex(`synthetic-peer:${channelId}`)],
    );
    await client.query(
      'insert into overlay_capabilities(hash,world_id,channel_id) values($1,$2,$3)',
      [sha256Hex(readCapability), scope.worldId, channelId],
    );
    return false;
  });
  return { worldId: scope.worldId, channelId, readCapability, duplicate };
}
