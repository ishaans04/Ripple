import {
  blueprintSchema,
  studioChallengeSchema,
  type AppearanceBlueprint,
} from '@ripple/contracts';
import {
  StudioRuleError,
  commitStudioAdaptation,
  committedStudioAppearance,
  freezeBaseline,
  openRoundClock,
  releaseMutationSlot,
  type BaselineRound,
  type RoundCheckpoint,
  type RoundClock,
} from '@ripple/engine';
import { effect, type CommandEffect } from './lifecycle.ts';
import { genomeOf, saveCheckpoint, type GameContext, type OrganismRow } from './store.ts';
import { captureRoundParticipants } from './visitor-observation.ts';
import {
  activeStudioSession,
  cancelStudioForInactive,
  recordStudioTransition,
  type StudioSessionRow,
} from './studio.ts';

interface PendingRow {
  id: string;
  session_id: string;
  organism_id: string;
  blueprint_hash: string;
  target_slot: number;
  status: string;
  approval: { channelCredit: string; artistCredit: string | null };
}

export async function pendingAdaptationFor(
  context: GameContext,
  organismId: string,
): Promise<PendingRow | null> {
  return (
    (
      await context.client.query<PendingRow>(
        "select * from pending_adaptations where world_id=$1 and organism_id=$2 and status='pending'",
        [context.channel.world_id, organismId],
      )
    ).rows[0] ?? null
  );
}

/**
 * The eligible boundary is the resident's next ordinary mutation ballot: the approved design
 * takes that slot instead of cards, so chat sees an incubating cocoon rather than a vote.
 */
export function hatchCheckpoint(
  input: {
    readonly atMs: number;
    readonly actor: OrganismRow;
    readonly history: readonly BaselineRound[];
    readonly pending: { id: string; session_id: string; blueprint_hash: string };
  },
  context: GameContext,
): RoundCheckpoint {
  return {
    schemaVersion: 1,
    clock: openRoundClock(input.atMs, context.timings),
    candidates: [],
    baseline: freezeBaseline(input.history, context.rules),
    genomeBefore: genomeOf(input.actor),
    counts: [],
    shocks: [],
    studioHatch: {
      adaptationId: input.pending.id,
      sessionId: input.pending.session_id,
      hash: input.pending.blueprint_hash,
    },
  };
}

/**
 * One transaction verifies eligibility and the organism version, consumes the reserved slot,
 * applies any gene change, sets the immutable design, records provenance and marks the
 * adaptation committed. The public hatch is inserted with it and published only after commit.
 */
export async function commitStudioHatch(
  context: GameContext,
  clock: RoundClock,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const { client, channel, round, organism, rules } = context;
  const hatch = round?.checkpoint.studioHatch;
  if (round === null || organism === null || hatch === undefined)
    throw new Error('Missing studio hatch round.');
  const pending = (
    await client.query<PendingRow>(
      'select * from pending_adaptations where world_id=$1 and id=$2',
      [channel.world_id, hatch.adaptationId],
    )
  ).rows[0];
  const session = (
    await client.query<StudioSessionRow>(
      'select * from studio_sessions where world_id=$1 and id=$2',
      [channel.world_id, hatch.sessionId],
    )
  ).rows[0];
  const design = (
    await client.query<{ hash: string; canonical: string; blueprint: AppearanceBlueprint }>(
      'select hash,canonical,blueprint from appearance_blueprints where world_id=$1 and hash=$2',
      [channel.world_id, hatch.hash],
    )
  ).rows[0];
  if (pending === undefined || session === undefined || design === undefined)
    throw new Error('Missing recorded studio adaptation.');
  await client.query('update rounds set close_sequence=$3 where world_id=$1 and id=$2', [
    channel.world_id,
    round.id,
    sequence,
  ]);
  let failure: string | null =
    pending.status !== 'pending' || session.phase !== 'PENDING_HATCH'
      ? 'adaptation_not_pending'
      : null;
  let committed: ReturnType<typeof commitStudioAdaptation> | null = null;
  if (failure === null)
    try {
      committed = commitStudioAdaptation(
        {
          id: pending.id,
          challenge: studioChallengeSchema.parse(session.challenge),
          design: {
            blueprint: blueprintSchema.parse(design.blueprint),
            canonical: design.canonical,
            hash: design.hash,
          },
        },
        {
          id: organism.id,
          version: organism.design_version,
          genome: genomeOf(organism),
          status: organism.status,
          appearanceHash: organism.appearance_hash,
          appearance: null,
        },
        organism.mutation_slots,
        organism.mutation_slots.next,
        rules,
      );
    } catch (error) {
      if (!(error instanceof StudioRuleError)) throw error;
      failure = error.code;
    }
  await saveCheckpoint(context, { ...round.checkpoint, clock });
  if (committed === null) {
    // A rejected design leaves genes and the slot untouched; only its reservation is released.
    const slots = releaseMutationSlot(organism.mutation_slots, pending.id);
    await client.query('update organisms set mutation_slots=$3 where world_id=$1 and id=$2', [
      channel.world_id,
      organism.id,
      JSON.stringify(slots),
    ]);
    context.organism = { ...organism, mutation_slots: slots };
    if (pending.status === 'pending')
      await client.query(
        "update pending_adaptations set status='cancelled',reason=$3,resolved_at=$4 where world_id=$1 and id=$2",
        [channel.world_id, pending.id, failure, new Date(atMs)],
      );
    if (session.phase === 'PENDING_HATCH')
      await recordStudioTransition(
        context,
        session,
        'base_invalid',
        sequence,
        atMs,
        { code: failure },
        {
          outcome: { reason: failure ?? 'base_invalid' },
        },
      );
    await captureRoundParticipants(context);
    return effect('APPLIED', 'studio.cancelled', {
      sessionId: session.id,
      adaptationId: pending.id,
      reason: failure,
      genesUnchanged: true,
    });
  }
  const appearance = committedStudioAppearance(
    committed.organism.appearance ?? blueprintSchema.parse(design.blueprint),
    organism.appearance_hash,
    pending.approval.channelCredit,
    pending.approval.artistCredit === null
      ? null
      : { optedIn: true, credit: pending.approval.artistCredit },
  );
  if (committed.outcome === 'committed') {
    const genome = committed.organism.genome;
    await client.query(
      `update organisms set pulse=$3,calm=$4,grit=$5,drift=$6,mutation_slots=$7,appearance=$8,appearance_hash=$9,
      version=version+1,design_version=design_version+1 where world_id=$1 and id=$2`,
      [
        channel.world_id,
        organism.id,
        genome.pulse,
        genome.calm,
        genome.grit,
        genome.drift,
        JSON.stringify(committed.slots),
        JSON.stringify(appearance),
        design.hash,
      ],
    );
    context.organism = {
      ...organism,
      ...genome,
      mutation_slots: committed.slots,
      appearance,
      appearance_hash: design.hash,
      version: organism.version + 1,
      design_version: organism.design_version + 1,
    };
    await client.query(
      "update pending_adaptations set status='committed',committed_round_id=$3,resolved_at=$4 where world_id=$1 and id=$2",
      [channel.world_id, pending.id, round.id, new Date(atMs)],
    );
    await recordStudioTransition(
      context,
      session,
      'hatched',
      sequence,
      atMs,
      { roundId: round.id },
      {
        outcome: { reason: 'hatched' },
      },
    );
  }
  await captureRoundParticipants(context);
  return effect('APPLIED', 'appearance.committed', {
    sessionId: session.id,
    adaptationId: pending.id,
    hash: design.hash,
    template: design.blueprint.mutationTemplateId,
    genome: genomeOf(context.organism ?? organism),
  });
}

/** Called after settlement: a fossil cancels its studio and any pending adaptation. */
export async function settleStudioAfterObservation(
  context: GameContext,
  sequence: number,
  atMs: number,
): Promise<boolean> {
  if ((await activeStudioSession(context)) === null) return false;
  return cancelStudioForInactive(context, sequence, atMs);
}
