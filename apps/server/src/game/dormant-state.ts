import { blueprintSchema, type AppearanceBlueprint } from '@ripple/contracts';
import {
  committedStudioAppearance,
  evaluateDormantBlueprint,
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
  blueprint_hash: string | null;
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
    /** A losing studio finalist whose design travels with the direction (addendum 14.3). */
    studio?: { sessionId: string; blueprintHash: string };
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
): Promise<{ row: DormantRow; move: MutationMove; blueprintHash: string | null } | null> {
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
  // The design is revalidated against the current template and renderer before it is offered.
  let blueprintHash: string | null = null;
  if (row.blueprint_hash !== null) {
    const design = (
      await client.query<{ blueprint: unknown }>(
        'select blueprint from appearance_blueprints where world_id=$1 and hash=$2',
        [channel.world_id, row.blueprint_hash],
      )
    ).rows[0];
    const valid = evaluateDormantBlueprint(
      design?.blueprint,
      genomeOf(organism),
      row.remaining_rounds,
      rules,
    );
    blueprintHash = valid.eligible ? row.blueprint_hash : null;
  }
  await client.query(
    'update dormant_mutations set offered=true,version=version+1 where world_id=$1 and id=$2',
    [channel.world_id, row.id],
  );
  return {
    row: { ...row, offered: true, version: row.version + 1 },
    move: offered.move,
    blueprintHash,
  };
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

/**
 * A qualifying losing studio finalist attaches its design to a dormant capture under the
 * ordinary thresholds. Its profile is the last valid habitat profile, or null when none exists,
 * so it can never trigger against invented data.
 */
export async function captureStudioDormant(
  context: GameContext,
  input: {
    sessionId: string;
    ballotRoundId: string;
    organismId: string;
    move: MutationMove;
    blueprintHash: string;
    supporters: number;
    totalVotes: number;
  },
  sequence: number,
): Promise<{ capturedId: string; replacedId: string | null }> {
  const { client, channel } = context;
  const origin = (
    await client.query<{ lineage_id: string; generation: number }>(
      'select lineage_id,generation from organisms where world_id=$1 and id=$2',
      [channel.world_id, input.organismId],
    )
  ).rows[0];
  if (origin === undefined) throw new Error('Missing studio dormant organism.');
  const recent = (
    await client.query<{ round_id: string; burst: number }>(
      'select round_id,burst from habitat_baselines where world_id=$1 and channel_id=$2 order by completed_at desc,round_id desc limit 1',
      [channel.world_id, channel.id],
    )
  ).rows[0];
  const previous = (
    await client.query<{ id: string }>(
      "update dormant_mutations set status='replaced',consumption=$3,version=version+1 where world_id=$1 and organism_id=$2 and status='active' returning id",
      [
        channel.world_id,
        input.organismId,
        { reason: 'replaced', roundId: input.ballotRoundId, sequence },
      ],
    )
  ).rows[0];
  const id = operationId(channel.id, sequence, `studio-dormant:${input.organismId}`);
  const lifetime = newValidRoundLifetime(
    input.ballotRoundId,
    context.mechanics.policy.dormantRounds,
  );
  await client.query(
    `insert into dormant_mutations(world_id,id,organism_id,source_round_id,template,provenance,remaining_hops,remaining_rounds,status,lifetime,blueprint_hash)
     values($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10)`,
    [
      channel.world_id,
      id,
      input.organismId,
      input.ballotRoundId,
      input.move,
      {
        originChannelId: channel.id,
        lineageId: origin.lineage_id,
        supporters: input.supporters,
        totalVotes: input.totalVotes,
        captureProfile:
          recent === undefined
            ? null
            : { roundId: recent.round_id, burst: recent.burst, steadiness: 1000 - recent.burst },
        captureSequence: sequence,
        studio: { sessionId: input.sessionId, blueprintHash: input.blueprintHash },
      },
      16 - origin.generation,
      lifetime.remainingRounds,
      lifetime,
      input.blueprintHash,
    ],
  );
  return { capturedId: id, replacedId: previous?.id ?? null };
}

/** The receiving community chose the dormant card, so its revalidated design is committed too. */
export async function expressDormantDesign(
  context: GameContext,
  choiceId: string | null,
): Promise<string | null> {
  const { round, organism, client, channel } = context;
  const offer = round?.checkpoint.dormantOffer;
  const card = round?.checkpoint.candidates.find((candidate) => candidate.source === 'dormant');
  if (offer?.blueprintHash === undefined || choiceId !== card?.id || organism === null) return null;
  const design = (
    await client.query<{ blueprint: AppearanceBlueprint; label: string }>(
      `select b.blueprint,c.label from appearance_blueprints b join channels c on c.world_id=b.world_id and c.id=$3
      where b.world_id=$1 and b.hash=$2`,
      [channel.world_id, offer.blueprintHash, offer.originChannelId],
    )
  ).rows[0];
  if (design === undefined) throw new Error('Missing dormant studio design.');
  const appearance = committedStudioAppearance(
    blueprintSchema.parse(design.blueprint),
    organism.appearance_hash,
    design.label.slice(0, 40),
    null,
  );
  await client.query(
    'update organisms set appearance=$3,appearance_hash=$4 where world_id=$1 and id=$2',
    [channel.world_id, organism.id, JSON.stringify(appearance), offer.blueprintHash],
  );
  context.organism = { ...organism, appearance, appearance_hash: offer.blueprintHash };
  return offer.blueprintHash;
}
