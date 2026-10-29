import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { transferViewSchema, type GameCommand } from '@ripple/contracts';
import { admissionEligibility, pendingAdmissions, reconsiderAdmission } from './admissions.ts';
import { effect, type CommandEffect } from './lifecycle.ts';
import { loadRaidPolicy, readTransfer } from './propagation-store.ts';
import { transferJoins, transferProjectionSql } from './propagation-projection.ts';
import type { GameContext } from './store.ts';

/** Owner-only lookup; a copied URL never supplies destination authority. */
export async function historicalOffers(
  pool: pg.Pool,
  worldId: string,
  channelId: string,
  transferId?: string,
) {
  const rows = await pool.query<{ view: unknown }>(
    `select ${transferProjectionSql} as view from transfers t ${transferJoins}
    join channels claimant on claimant.world_id=t.world_id and claimant.id=$2
    join worlds w on w.id=t.world_id
    where t.world_id=$1 and t.destination_channel_id is null and t.child_id is not null
    and t.outcome='NOT_ENROLLED' and lower(t.destination_twitch_id)=lower(coalesce(claimant.twitch_id,claimant.id::text))
    and t.source_channel_id<>claimant.id and t.expires_at>coalesce(w.clock_at,clock_timestamp())
    and ($3::uuid is null or t.id=$3) order by t.created_at desc,t.id limit 10`,
    [worldId, channelId, transferId ?? null],
  );
  return rows.rows.map((row) => transferViewSchema.parse(row.view));
}

/** Source/destination locks are held in canonical order; the child was reserved at the actual raid. */
export async function claimHistoricalRaid(
  context: GameContext,
  command: Extract<GameCommand, { type: 'claimRaid' }>,
  sequence: number,
  acceptedAtMs: number,
): Promise<CommandEffect> {
  const { client, channel } = context;
  const transfer = await readTransfer(client, channel.world_id, command.transferId);
  if (transfer === null) return effect('CLAIM_NOT_AVAILABLE');
  if (transfer.version !== command.transferVersion) return effect('STALE_VERSION');
  if (
    transfer.destination_channel_id !== null ||
    transfer.outcome !== 'NOT_ENROLLED' ||
    transfer.child_id === null ||
    transfer.source_channel_id === channel.id
  )
    return effect('CLAIM_NOT_AVAILABLE');
  if (command.claimantTwitchId?.toLowerCase() !== transfer.destination_twitch_id.toLowerCase())
    return effect('NOT_CLAIM_DESTINATION');
  const atMs = Math.max(acceptedAtMs, command.checkedAtMs ?? acceptedAtMs);
  if (transfer.expires_at === null || atMs >= transfer.expires_at.getTime())
    return effect('CLAIM_EXPIRED');
  const policy = await loadRaidPolicy(client, channel.world_id);
  if ((await pendingAdmissions(context)).length >= policy.harborCap)
    return effect('CLAIM_CAPACITY');
  const child = await client.query(
    "select 1 from organisms where world_id=$1 and id=$2 and status='HARBOR'",
    [channel.world_id, transfer.child_id],
  );
  if (child.rowCount !== 1) return effect('CLAIM_NOT_AVAILABLE');
  await client.query(
    `update deadlines set status='cancelled',lease_owner=null,lease_until=null
    where world_id=$1 and channel_id=$2 and job_key=$3 and status in ('pending','leased')`,
    [channel.world_id, transfer.source_channel_id, `admission-expiry:${transfer.id}`],
  );
  await client.query(
    `update transfers set destination_channel_id=$3,claimed_at=$4,destination_sequence=$5,
    outcome='QUEUED',version=version+1 where world_id=$1 and id=$2 and version=$6`,
    [channel.world_id, transfer.id, channel.id, new Date(atMs), sequence, transfer.version],
  );
  await client.query(
    `insert into transfer_transitions(world_id,transfer_id,version,outcome,at,channel_id,sequence,detail)
    values($1,$2,$3,'QUEUED',$4,$5,$6,$7)`,
    [
      channel.world_id,
      transfer.id,
      transfer.version + 1,
      new Date(atMs),
      channel.id,
      sequence,
      JSON.stringify({ historical: true, originalRaidAt: transfer.created_at.toISOString() }),
    ],
  );
  await client.query(
    `insert into deadlines(world_id,channel_id,id,job_key,command,due_at,remaining_ms)
    values($1,$2,$3,$4,$5,$6,$7)`,
    [
      channel.world_id,
      channel.id,
      randomUUID(),
      `admission-expiry:${transfer.id}`,
      JSON.stringify({ type: 'expireAdmission', transferId: transfer.id }),
      transfer.expires_at,
      transfer.expires_at.getTime() - atMs,
    ],
  );
  const bound = await readTransfer(client, channel.world_id, transfer.id);
  if (bound === null) throw new Error('Historical transfer disappeared under its channel locks.');
  const result = await reconsiderAdmission(
    context,
    bound,
    sequence,
    atMs,
    command.eligibility ?? (await admissionEligibility(context)),
    true,
  );
  return {
    ...result,
    detail: {
      ...result.detail,
      historical: true,
      originalRaidAt: transfer.created_at.toISOString(),
    },
    dependencies: [
      { channelId: transfer.source_channel_id, sequence: transfer.snapshot.sourceSequence },
    ],
  };
}
