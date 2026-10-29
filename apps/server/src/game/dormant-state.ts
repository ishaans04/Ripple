import {
  consumeValidRound,
  evaluateDormantOffer,
  newValidRoundLifetime,
  selectDormantCapture,
  type MutationMove,
  type HabitatProfile,
  type TallyResult,
  type ValidRoundLifetime,
} from '@ripple/engine';
import { operationId } from './operation-id.ts';
import type { GameContext } from './store.ts';
import { genomeOf } from './store.ts';

export interface DormantRow {
  id: string;
  organism_id: string;
  source_round_id: string;
  template: MutationMove;
  provenance: {
    originChannelId: string;
    lineageId: string;
    supporters: number;
    totalVotes: number;
    captureProfile: { roundId: string; burst: number; steadiness: number } | null;
    captureSequence: number;
    inheritedFrom?: {
      organismId: string;
      dormantId: string;
      version: number;
      transferId: string;
      sequence: number;
    };
  };
  lifetime: ValidRoundLifetime;
  remaining_rounds: number;
  remaining_hops: number;
  offered: boolean;
  version: number;
}

export async function offerDormantMutation(
  context: GameContext,
  recentProfile: HabitatProfile | null,
): Promise<{ row: DormantRow; move: MutationMove } | null> {
  if (context.mechanics.version !== 1 || context.organism === null) return null;
  const { client, channel, organism, rules } = context;
  const row = (
    await client.query<DormantRow>(
      "select * from dormant_mutations where world_id=$1 and organism_id=$2 and status='active' and not offered and remaining_rounds>0",
      [channel.world_id, organism.id],
    )
  ).rows[0];
  if (row === undefined) return null;
  const offered = evaluateDormantOffer(
    {
      capture: {
        move: row.template,
        supporters: row.provenance.supporters,
        totalVotes: row.provenance.totalVotes,
        captureBurst: row.provenance.captureProfile?.burst ?? null,
      },
      genome: genomeOf(organism),
      recentProfile,
    },
    rules,
  );
  if (!offered.eligible) return null;
  await client.query(
    'update dormant_mutations set offered=true,version=version+1 where world_id=$1 and id=$2',
    [channel.world_id, row.id],
  );
  return { row: { ...row, offered: true, version: row.version + 1 }, move: offered.move };
}

export async function consumeDormantOffer(
  context: GameContext,
  choiceId: string | null,
  sequence: number,
): Promise<string | null> {
  const { round, client, channel } = context;
  const offer = round?.checkpoint.dormantOffer;
  if (offer === undefined || round === null) return null;
  const card = round.checkpoint.candidates.find((candidate) => candidate.source === 'dormant');
  if (card === undefined) throw new Error('Dormant offer has no captured ballot card.');
  const changed = await client.query(
    "update dormant_mutations set status='consumed',consumption=$4,version=version+1 where world_id=$1 and id=$2 and status='active' and offered and version=$3",
    [
      channel.world_id,
      offer.id,
      offer.version,
      { reason: choiceId === card.id ? 'selected' : 'rejected', roundId: round.id, sequence },
    ],
  );
  if (changed.rowCount !== 1)
    throw new Error('Captured dormant offer changed before ballot close.');
  return offer.id;
}

/** A qualified minority direction is inert until an eligible, explicit future ballot. */
export async function captureDormantMutation(
  context: GameContext,
  tally: TallyResult,
  sequence: number,
): Promise<{ capturedId: string; replacedId: string | null } | null> {
  if (context.mechanics.version !== 1) return null;
  const { round, organism, client, channel, rules } = context;
  if (round === null || organism === null || round.checkpoint.specialBallot !== undefined)
    return null;
  const preview = round.checkpoint.choicePreview;
  const captureProfile =
    preview?.status === 'estimate'
      ? {
          roundId: preview.sourceRoundId,
          burst: preview.hold.burst,
          steadiness: preview.hold.steadiness,
        }
      : null;
  const captured = selectDormantCapture(
    {
      candidates: round.checkpoint.candidates,
      tally,
      captureBurst: captureProfile?.burst ?? null,
    },
    rules,
  );
  if (captured === null) return null;
  const origin = (
    await client.query<{ lineage_id: string; generation: number }>(
      'select lineage_id,generation from organisms where world_id=$1 and id=$2',
      [channel.world_id, organism.id],
    )
  ).rows[0];
  if (origin === undefined) throw new Error('Missing dormant capture organism.');
  const previous = (
    await client.query<{ id: string }>(
      "update dormant_mutations set status='replaced',consumption=$3,version=version+1 where world_id=$1 and organism_id=$2 and status='active' returning id",
      [channel.world_id, organism.id, { reason: 'replaced', roundId: round.id, sequence }],
    )
  ).rows[0];
  const id = operationId(channel.id, sequence, `dormant:${organism.id}`);
  const lifetime = newValidRoundLifetime(round.id, context.mechanics.policy.dormantRounds);
  await client.query(
    `insert into dormant_mutations(world_id,id,organism_id,source_round_id,template,provenance,remaining_hops,remaining_rounds,status,lifetime)
     values($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)`,
    [
      channel.world_id,
      id,
      organism.id,
      round.id,
      captured.move,
      {
        originChannelId: channel.id,
        lineageId: origin.lineage_id,
        supporters: captured.supporters,
        totalVotes: captured.totalVotes,
        captureProfile,
        captureSequence: sequence,
      },
      16 - origin.generation,
      lifetime.remainingRounds,
      lifetime,
    ],
  );
  return { capturedId: id, replacedId: previous?.id ?? null };
}

/** Existing inherited rows also age in legacy hosts; legacy rounds still cannot capture or offer. */
export async function ageDormantMutations(
  context: GameContext,
  sequence: number,
): Promise<readonly string[]> {
  const { round, client, channel } = context;
  if (round === null) throw new Error('Missing dormant aging round.');
  const rows = (
    await client.query<DormantRow & { organism_status: string }>(
      `select d.*,o.status as organism_status from dormant_mutations d join organisms o on o.world_id=d.world_id and o.id=d.organism_id
     join round_participants p on p.world_id=d.world_id and p.organism_id=d.organism_id and p.round_id=$2
     where d.world_id=$1 and d.status='active' and p.resolution->>'outcome'='applied' order by d.id`,
      [channel.world_id, round.id],
    )
  ).rows;
  const changed: string[] = [];
  for (const row of rows) {
    const aged = consumeValidRound(row.lifetime, round.id, true);
    const fossil = row.organism_status === 'FOSSIL';
    if (aged === row.lifetime && !fossil) continue;
    const expired = fossil || aged.remainingRounds === 0;
    const lifetime = fossil ? { ...aged, remainingRounds: 0 } : aged;
    await client.query(
      `update dormant_mutations set lifetime=$3,remaining_rounds=$4,status=$5,consumption=$6,version=version+1 where world_id=$1 and id=$2`,
      [
        channel.world_id,
        row.id,
        lifetime,
        lifetime.remainingRounds,
        expired ? 'expired' : 'active',
        expired
          ? { reason: fossil ? 'fossil' : 'valid-round-expiry', roundId: round.id, sequence }
          : null,
      ],
    );
    changed.push(row.id);
  }
  return changed;
}
