import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ChannelControl, GameCommand } from '@ripple/contracts';
import { ControlError, type OwnerSession } from './sessions.ts';

/** Called under the destination channel lock, after the idempotency lookup. */
export async function ownerControlCommand(
  client: pg.PoolClient,
  owner: OwnerSession,
  body: ChannelControl,
): Promise<GameCommand> {
  if (body.action === 'enableMechanics')
    return { type: 'enableMechanics', expectedVersion: body.expectedVersion };
  if (body.action === 'clearTrace')
    return { type: 'clearTrace', expectedVersion: body.expectedVersion };
  if (body.action === 'setTraces')
    return { type: 'setTraces', enabled: body.enabled, expectedVersion: body.expectedVersion };
  if (body.action === 'claimRaid') {
    const transfer = (
      await client.query<{ version: number }>(
        `select t.version from transfers t join channels c on c.world_id=t.world_id and c.id=$2
      where t.world_id=$1 and t.id=$3 and t.destination_channel_id is null and t.child_id is not null
      and t.outcome='NOT_ENROLLED' and lower(t.destination_twitch_id)=lower(c.twitch_id)
      and t.source_channel_id<>c.id`,
        [owner.world_id, owner.channel_id, body.transferId],
      )
    ).rows[0];
    if (transfer === undefined) throw new ControlError(404, 'NOT_FOUND');
    if (transfer.version !== body.transferVersion) throw new ControlError(409, 'STALE_VERSION');
    return {
      type: 'claimRaid',
      transferId: body.transferId,
      transferVersion: body.transferVersion,
      expectedVersion: body.expectedVersion,
    };
  }
  if (body.action === 'admission') {
    const transfer = (
      await client.query<{ version: number }>(
        'select version from transfers where world_id=$1 and destination_channel_id=$2 and id=$3',
        [owner.world_id, owner.channel_id, body.transferId],
      )
    ).rows[0];
    if (transfer === undefined) throw new ControlError(404, 'NOT_FOUND');
    if (transfer.version !== body.transferVersion) throw new ControlError(409, 'STALE_VERSION');
    return {
      type: 'admission',
      expectedVersion: body.expectedVersion,
      transferId: body.transferId,
      transferVersion: body.transferVersion,
      decision: body.decision,
      roundId: randomUUID(),
    };
  }
  if (body.action === 'blockSource') {
    const source = await client.query('select 1 from channels where world_id=$1 and id=$2', [
      owner.world_id,
      body.sourceChannelId,
    ]);
    if (source.rowCount !== 1) throw new ControlError(404, 'NOT_FOUND');
    return {
      type: 'blockSource',
      sourceChannelId: body.sourceChannelId,
      blocked: body.blocked,
      expectedVersion: body.expectedVersion,
    };
  }
  if (body.action === 'blockLineage') {
    const lineage = await client.query('select 1 from lineages where world_id=$1 and id=$2', [
      owner.world_id,
      body.lineageId,
    ]);
    if (lineage.rowCount !== 1) throw new ControlError(404, 'NOT_FOUND');
    return {
      type: 'blockLineage',
      lineageId: body.lineageId,
      blocked: body.blocked,
      expectedVersion: body.expectedVersion,
    };
  }
  return { type: 'prepare', expectedVersion: body.expectedVersion };
}
