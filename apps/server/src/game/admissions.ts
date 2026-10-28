import { admissionExpired, admissionOutcome, type AdmissionOutcome } from '@ripple/engine';
import type { PropagationCommand } from '@ripple/contracts';
import { effect, type CommandEffect } from './lifecycle.ts';
import {
  loadRaidPolicy,
  readTransfer,
  recordTransferTransition,
  type TransferRow,
} from './propagation-store.ts';
import type { GameContext, OrganismRow } from './store.ts';
import { saveCheckpoint } from './store.ts';

export const pendingAdmissionOutcomes = Object.freeze([
  'QUEUED',
  'PENDING_APPROVAL',
  'OFFLINE_HOLD',
  'GRANT_REVOKED',
  'INPUT_UNAVAILABLE',
  'RULES_INCOMPATIBLE',
  'HARBOR',
]);
export interface AdmissionEligibility {
  authorized: boolean;
  rulesCompatible: boolean;
}
export async function admissionEligibility(context: GameContext): Promise<AdmissionEligibility> {
  const { client, channel } = context;
  const row = (
    await client.query<{ authorized: boolean; rules_compatible: boolean }>(
      `select p.rules_compatible, w.mode<>'live' or (
    exists(select 1 from oauth_grants g where g.world_id=c.world_id and g.channel_id=c.id and g.purpose='broadcaster' and g.revoked_at is null and g.expires_at>clock_timestamp() and g.validated_at>clock_timestamp()-interval '1 hour') and
    exists(select 1 from oauth_grants g where g.world_id=c.world_id and g.purpose='bot' and g.revoked_at is null and g.expires_at>clock_timestamp() and g.validated_at>clock_timestamp()-interval '1 hour')) as authorized
    from channels c join worlds w on w.id=c.world_id join channel_play p on p.world_id=c.world_id and p.channel_id=c.id where c.world_id=$1 and c.id=$2`,
      [channel.world_id, channel.id],
    )
  ).rows[0];
  if (row === undefined) throw new Error('Missing admission authority');
  return { authorized: row.authorized, rulesCompatible: row.rules_compatible };
}
async function cancelExpiry(context: GameContext, id: string): Promise<void> {
  await context.client.query(
    "update deadlines set status='cancelled',lease_owner=null,lease_until=null where world_id=$1 and channel_id=$2 and job_key=$3 and status in ('pending','leased')",
    [context.channel.world_id, context.channel.id, `admission-expiry:${id}`],
  );
}
async function archive(
  context: GameContext,
  transfer: TransferRow,
  outcome: string,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const { client, channel } = context;
  if (transfer.child_id !== null) {
    await client.query(
      'select l.id from lineages l join organisms o on o.world_id=l.world_id and o.lineage_id=l.id where o.world_id=$1 and o.id=$2 for update of l',
      [channel.world_id, transfer.child_id],
    );
    await client.query(
      "update organisms set status='ARCHIVED',version=version+1 where world_id=$1 and id=$2 and status in ('ALIVE','HARBOR')",
      [channel.world_id, transfer.child_id],
    );
    await client.query(
      'update residencies set ended_at=$3 where world_id=$1 and organism_id=$2 and ended_at is null',
      [channel.world_id, transfer.child_id, new Date(atMs)],
    );
    if (context.organism?.id === transfer.child_id)
      context.organism = { ...context.organism, status: 'ARCHIVED' };
    const round = context.round;
    if (
      round?.checkpoint.specialBallot?.kind === 'WELCOME' &&
      round.checkpoint.specialBallot.visitorId === transfer.child_id
    ) {
      await saveCheckpoint(context, {
        ...round.checkpoint,
        clock: {
          ...round.checkpoint.clock,
          phase: 'COMPLETE',
          paused: true,
          deadlineAtMs: null,
          remainingMs: 0,
          revision: round.checkpoint.clock.revision + 1,
        },
      });
      await client.query('update rounds set completed_at=$3 where world_id=$1 and id=$2', [
        channel.world_id,
        round.id,
        new Date(atMs),
      ]);
      context.round = null;
    }
  }
  await recordTransferTransition(client, transfer, outcome, channel.id, sequence, atMs, {
    admissionRefusal: true,
  });
  await cancelExpiry(context, transfer.id);
  return effect('APPLIED', 'admission.changed', {
    transferId: transfer.id,
    outcome,
    archived: true,
  });
}
export async function pendingAdmissions(context: GameContext): Promise<TransferRow[]> {
  return (
    await context.client.query<TransferRow>(
      'select * from transfers where world_id=$1 and destination_channel_id=$2 and child_id is not null and outcome=any($3::text[]) order by destination_sequence nulls last,created_at,id limit 3',
      [context.channel.world_id, context.channel.id, pendingAdmissionOutcomes],
    )
  ).rows;
}
export async function reconsiderAdmission(
  context: GameContext,
  transfer: TransferRow,
  sequence: number,
  atMs: number,
  eligibility: AdmissionEligibility,
  approve = false,
): Promise<CommandEffect> {
  const { client, channel } = context;
  if (
    transfer.destination_channel_id !== channel.id ||
    transfer.world_id !== channel.world_id ||
    transfer.child_id === null ||
    !pendingAdmissionOutcomes.includes(transfer.outcome)
  )
    return effect('NO_CHANGE');
  if (transfer.expires_at === null) throw new Error('Pending admission has no expiry');
  if (admissionExpired(atMs, transfer.expires_at.getTime()))
    return archive(context, transfer, 'EXPIRED', sequence, atMs);
  const policy = await loadRaidPolicy(client, channel.world_id),
    queue = await pendingAdmissions(context);
  const waitingAhead = Math.max(
    0,
    queue.findIndex((t) => t.id === transfer.id),
  );
  const blocked =
    (
      await client.query(
        'select 1 from source_blocks where world_id=$1 and channel_id=$2 and source_channel_id=$3',
        [channel.world_id, channel.id, transfer.source_channel_id],
      )
    ).rowCount !== 0;
  const settings = (
    await client.query<{ visitor_policy: 'ask' | 'accept' | 'reject' }>(
      'select visitor_policy from twitch_channels where world_id=$1 and channel_id=$2',
      [channel.world_id, channel.id],
    )
  ).rows[0];
  const busy =
    (
      await client.query(
        "select 1 from residencies where world_id=$1 and channel_id=$2 and role='visitor' and ended_at is null",
        [channel.world_id, channel.id],
      )
    ).rowCount !== 0;
  const outcome: AdmissionOutcome = admissionOutcome(
    {
      enrolled: true,
      sourceBlocked: blocked,
      policy: settings?.visitor_policy ?? 'ask',
      approved: approve || transfer.approved_at !== null,
      rulesCompatible:
        eligibility.rulesCompatible && transfer.snapshot.sourceRulesHash === channel.rules_hash,
      authorized: eligibility.authorized,
      healthy: channel.healthy && context.round?.phase !== 'INTERRUPTED',
      online: channel.online,
      paused: channel.paused,
      visitorBusy: busy || waitingAhead > 0,
      waitingAhead,
    },
    policy,
  );
  if (['SOURCE_BLOCKED', 'POLICY_REJECTED', 'HARBOR_FULL'].includes(outcome))
    return archive(context, transfer, outcome, sequence, atMs);
  const newlyApproved = approve && transfer.approved_at === null;
  if (outcome === transfer.outcome && !newlyApproved) return effect('NO_CHANGE');
  await recordTransferTransition(
    client,
    transfer,
    outcome,
    channel.id,
    sequence,
    atMs,
    { sourceSequence: transfer.snapshot.sourceSequence },
    newlyApproved,
  );
  const active = outcome === 'ACTIVE';
  await client.query(
    `insert into residencies(world_id,id,channel_id,organism_id,role,arrival_snapshot,started_at) values($1,$2,$3,$4,$5,$6,$7)
    on conflict(world_id,id) do update set role=excluded.role`,
    [
      channel.world_id,
      transfer.snapshot.residencyId,
      channel.id,
      transfer.child_id,
      active ? 'visitor' : 'harbor',
      JSON.stringify(transfer.snapshot),
      new Date(atMs),
    ],
  );
  if (active) {
    await client.query(
      "update organisms set status='ALIVE',version=version+1 where world_id=$1 and id=$2 and status='HARBOR'",
      [channel.world_id, transfer.child_id],
    );
    await client.query(
      'insert into visitor_state(world_id,organism_id,channel_id,transfer_id,shock_reduction) values($1,$2,$3,$4,$5)',
      [
        channel.world_id,
        transfer.child_id,
        channel.id,
        transfer.id,
        transfer.snapshot.arrival?.shockReduction ?? 0,
      ],
    );
    await cancelExpiry(context, transfer.id);
    if (context.organism?.status !== 'ALIVE')
      context.organism =
        (
          await client.query<OrganismRow>('select * from organisms where world_id=$1 and id=$2', [
            channel.world_id,
            transfer.child_id,
          ])
        ).rows[0] ?? null;
  }
  return {
    ...effect('APPLIED', active ? 'visitor.arrived' : 'admission.changed', {
      transferId: transfer.id,
      outcome,
      childId: transfer.child_id,
      originChannelId: transfer.snapshot.parent?.originChannelId ?? null,
      parentId: transfer.parent_id,
    }),
    dependencies: [
      { channelId: transfer.source_channel_id, sequence: transfer.snapshot.sourceSequence },
    ],
  };
}
export async function sweepAdmissions(
  context: GameContext,
  sequence: number,
  atMs: number,
  eligibility: AdmissionEligibility,
): Promise<CommandEffect> {
  const results: Readonly<Record<string, unknown>>[] = [],
    dependencies: Readonly<Record<string, unknown>>[] = [];
  for (const transfer of await pendingAdmissions(context)) {
    const result = await reconsiderAdmission(context, transfer, sequence, atMs, eligibility);
    if (result.code === 'APPLIED') {
      results.push(result.detail);
      dependencies.push(...(result.dependencies ?? []));
    }
  }
  return results.length === 0
    ? effect('NO_CHANGE')
    : { ...effect('APPLIED', 'admission.changed', { changes: results }), dependencies };
}
export async function applyAdmissionCommand(
  context: GameContext,
  command: Extract<
    PropagationCommand,
    { type: 'arrive' | 'admission' | 'expireAdmission' | 'admissionSweep' }
  >,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  if (command.type === 'admissionSweep')
    return sweepAdmissions(
      context,
      sequence,
      atMs,
      command.eligibility ?? (await admissionEligibility(context)),
    );
  const transfer = await readTransfer(context.client, context.channel.world_id, command.transferId);
  if (transfer?.destination_channel_id !== context.channel.id) return effect('NO_CHANGE');
  if (command.type === 'expireAdmission') {
    if (
      !pendingAdmissionOutcomes.includes(transfer.outcome) ||
      transfer.expires_at === null ||
      atMs < transfer.expires_at.getTime()
    )
      return effect('NO_CHANGE');
    return archive(context, transfer, 'EXPIRED', sequence, atMs);
  }
  if (command.type === 'admission') {
    if (command.transferVersion !== transfer.version) return effect('STALE_VERSION');
    if (command.decision === 'decline') {
      if (!pendingAdmissionOutcomes.includes(transfer.outcome) && transfer.outcome !== 'ACTIVE')
        return effect('NO_CHANGE');
      return archive(context, transfer, 'DECLINED', sequence, atMs);
    }
  }
  return reconsiderAdmission(
    context,
    transfer,
    sequence,
    atMs,
    command.eligibility ?? (await admissionEligibility(context)),
    command.type === 'admission' && command.decision === 'accept',
  );
}
