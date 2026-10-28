import type pg from 'pg';
import { raidPolicySchema, raidPolicyHash, type RaidPolicy } from '@ripple/engine';
import type { CommittedAppearance, Genome } from '@ripple/engine';

export interface TransferSnapshot {
  schemaVersion: 1;
  residencyId: string;
  arrivalRoundId: string;
  policy: RaidPolicy;
  policyHash: string;
  sourceRulesHash: string;
  sourceChannelId: string;
  sourceSequence: number;
  sourceVersion: number;
  parent: null | {
    id: string;
    version: number;
    lineageId: string;
    founderId: string;
    generation: number;
    name: string;
    genome: Genome;
    health: number;
    appearance: CommittedAppearance;
    originChannelId: string;
  };
  preparation: 'shield' | 'reserve' | 'neutral';
  arrival: { health: number; spent: number; shockReduction: number } | null;
  queuedAhead: readonly string[];
  livingBranchIds: readonly string[];
}
export interface TransferRow {
  world_id: string;
  id: string;
  receipt_id: string;
  source_channel_id: string;
  destination_channel_id: string | null;
  destination_twitch_id: string;
  parent_id: string | null;
  child_id: string | null;
  source_version: number;
  version: number;
  destination_sequence: number | null;
  outcome: string;
  snapshot: TransferSnapshot;
  expires_at: Date | null;
  created_at: Date;
  approved_at: Date | null;
}
export async function loadRaidPolicy(client: pg.PoolClient, worldId: string): Promise<RaidPolicy> {
  const row = (
    await client.query<{ hash: string; canonical: string }>(
      'select p.hash,p.canonical from world_raid_policies w join raid_policies p on p.hash=w.policy_hash where w.world_id=$1',
      [worldId],
    )
  ).rows[0];
  if (row === undefined) throw new Error('Missing immutable raid policy');
  const policy = raidPolicySchema.parse(JSON.parse(row.canonical) as unknown);
  if (raidPolicyHash(policy) !== row.hash) throw new Error('Raid policy hash mismatch');
  return policy;
}
export async function readTransfer(
  client: pg.PoolClient,
  worldId: string,
  id: string,
): Promise<TransferRow | null> {
  return (
    (
      await client.query<TransferRow>('select * from transfers where world_id=$1 and id=$2', [
        worldId,
        id,
      ])
    ).rows[0] ?? null
  );
}
export async function recordTransferTransition(
  client: pg.PoolClient,
  transfer: TransferRow,
  outcome: string,
  channelId: string,
  sequence: number,
  atMs: number,
  detail: Readonly<Record<string, unknown>> = {},
  approve = false,
): Promise<TransferRow> {
  const updated = (
    await client.query<TransferRow>(
      'update transfers set outcome=$4,version=version+1,approved_at=case when $5 then coalesce(approved_at,$6) else approved_at end where world_id=$1 and id=$2 and version=$3 returning *',
      [transfer.world_id, transfer.id, transfer.version, outcome, approve, new Date(atMs)],
    )
  ).rows[0];
  if (updated === undefined) throw new Error('Transfer version changed under channel lock');
  await client.query(
    'insert into transfer_transitions(world_id,transfer_id,version,outcome,at,channel_id,sequence,detail) values($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      updated.world_id,
      updated.id,
      updated.version,
      outcome,
      new Date(atMs),
      channelId,
      sequence,
      JSON.stringify(detail),
    ],
  );
  return updated;
}
