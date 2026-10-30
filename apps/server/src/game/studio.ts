import {
  MAX_BLUEPRINT_BYTES,
  blueprintSchema,
  studioChallengeSchema,
  studioSettingsSchema,
  type AppearanceBlueprint,
  type GameCommand,
  type GameResultCode,
  type StudioChallenge,
  type StudioSettings,
} from '@ripple/contracts';
import {
  StudioRuleError,
  acceptBlueprint,
  approveStudioAdaptation,
  canonicalJson,
  createStudioChallenge,
  isTerminalStudioPhase,
  pauseRoundClock,
  releaseMutationSlot,
  requireStudioTransition,
  resolveStudioSelection,
  resumeRoundClock,
  sha256Hex,
  shortlistStudioProposals,
  studioDormantFinalist,
  studioMutationMove,
  studioHoldsGame,
  studioOpeningEligibility,
  type BallotVote,
  type MutationSlots,
  type StudioEvent,
  type StudioFinalist,
  type StudioPhase,
} from '@ripple/engine';
import { effect, type CommandEffect } from './lifecycle.ts';
import { operationId } from './operation-id.ts';
import { captureStudioDormant } from './dormant-state.ts';
import { gameHeld, genomeOf, saveCheckpoint, type GameContext, type OrganismRow } from './store.ts';

export interface StudioSettingsRow {
  settings: StudioSettings;
  availability: 'ACTIVE' | 'REST' | 'UNKNOWN';
  availability_source: 'manual' | 'bridge' | 'stream' | 'integration' | null;
  bridge_scene: string | null;
  bridge_stale: boolean;
}
export interface StoredFinalist {
  proposalId: string;
  hash: string;
  template: string;
  credit: string;
  /** The artist's login only when they opted in; channel credit is the default. */
  artistCredit: string | null;
}
export interface StoredSelection {
  kind: 'keep_current' | 'design';
  reason: string | null;
  finalistIndex: number | null;
  counts: number[];
  totalVotes: number;
  dormantId?: string;
}
export interface StudioSessionRow {
  id: string;
  channel_id: string;
  organism_id: string;
  phase: StudioPhase;
  version: number;
  trigger: 'manual' | 'bridge';
  challenge: StudioChallenge;
  seed: string;
  settings: StudioSettings;
  creation_close_at: Date | null;
  voting_close_at: Date | null;
  review_expires_at: Date | null;
  ballot_round_id: string | null;
  shortlist: {
    finalists: StoredFinalist[];
    rejected: { proposalId: string; reason: string }[];
  } | null;
  selection: StoredSelection | null;
  adaptation_id: string | null;
  outcome: { reason: string } | null;
}
export interface StudioBallotCheckpoint {
  schemaVersion: 1;
  studioBallot: { sessionId: string; options: number };
  counts: number[];
  clock: { phase: 'VOTING' | 'COMPLETE'; deadlineAtMs: number | null };
}

const resultCodes: Readonly<Record<StudioRuleError['code'], GameResultCode>> = {
  INVALID_BLUEPRINT: 'INVALID_BLUEPRINT',
  BASE_STATE_CHANGED: 'BASE_STATE_CHANGED',
  MUTATION_NOT_LEGAL: 'MUTATION_NOT_LEGAL',
  SLOT_UNAVAILABLE: 'BASE_STATE_CHANGED',
  PENDING_ADAPTATION_EXISTS: 'PENDING_ADAPTATION_EXISTS',
  WRONG_WORLD: 'INVALID_BLUEPRINT',
  ORGANISM_INACTIVE: 'BASE_STATE_CHANGED',
  STUDIO_WRONG_PHASE: 'STUDIO_WRONG_PHASE',
};
export function studioResultCode(error: StudioRuleError): GameResultCode {
  return resultCodes[error.code];
}

export async function readStudioSettings(context: GameContext): Promise<StudioSettingsRow> {
  const row = (
    await context.client.query<StudioSettingsRow>(
      'select settings,availability,availability_source,bridge_scene,bridge_stale from channel_studio where world_id=$1 and channel_id=$2',
      [context.channel.world_id, context.channel.id],
    )
  ).rows[0];
  if (row === undefined) throw new Error('Missing channel studio settings.');
  return { ...row, settings: studioSettingsSchema.parse(row.settings) };
}
export async function activeStudioSession(context: GameContext): Promise<StudioSessionRow | null> {
  return (
    (
      await context.client.query<StudioSessionRow>(
        `select * from studio_sessions where world_id=$1 and channel_id=$2
        and phase in ('OPENING','CREATING','VOTING','REVIEW','PENDING_HATCH')`,
        [context.channel.world_id, context.channel.id],
      )
    ).rows[0] ?? null
  );
}
async function sessionById(context: GameContext, id: string): Promise<StudioSessionRow | null> {
  return (
    (
      await context.client.query<StudioSessionRow>(
        'select * from studio_sessions where world_id=$1 and channel_id=$2 and id=$3',
        [context.channel.world_id, context.channel.id, id],
      )
    ).rows[0] ?? null
  );
}
async function residentOrganism(context: GameContext): Promise<OrganismRow | null> {
  return (
    (
      await context.client.query<OrganismRow>(
        `select o.* from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id
        where r.world_id=$1 and r.channel_id=$2 and r.role='resident' and r.ended_at is null`,
        [context.channel.world_id, context.channel.id],
      )
    ).rows[0] ?? null
  );
}
async function organismById(context: GameContext, id: string): Promise<OrganismRow> {
  const row = (
    await context.client.query<OrganismRow>('select * from organisms where world_id=$1 and id=$2', [
      context.channel.world_id,
      id,
    ])
  ).rows[0];
  if (row === undefined) throw new Error('Missing studio organism.');
  return row;
}

type SessionPatch = Partial<{
  creation_close_at: Date | null;
  voting_close_at: Date | null;
  review_expires_at: Date | null;
  ballot_round_id: string;
  shortlist: unknown;
  selection: unknown;
  adaptation_id: string;
  outcome: unknown;
}>;
const jsonColumns = new Set(['shortlist', 'selection', 'outcome']);

/** Records one guarded phase change and its cause; stale studio deadlines are cancelled. */
export async function recordStudioTransition(
  context: GameContext,
  session: StudioSessionRow,
  event: StudioEvent,
  sequence: number,
  atMs: number,
  detail: Readonly<Record<string, unknown>> = {},
  patch: SessionPatch = {},
): Promise<void> {
  const to = requireStudioTransition(session.phase, event);
  const version = session.version + 1;
  const entries = Object.entries(patch);
  const sets = entries.map(([column], index) => `${column}=$${index + 6}`);
  await context.client.query(
    `update studio_sessions set phase=$3,version=$4,ended_at=case when $5::boolean then $${entries.length + 6}::timestamptz else null end${sets.length === 0 ? '' : `,${sets.join(',')}`}
    where world_id=$1 and id=$2`,
    [
      context.channel.world_id,
      session.id,
      to,
      version,
      isTerminalStudioPhase(to),
      ...entries.map(([column, value]) =>
        jsonColumns.has(column) && value !== null ? JSON.stringify(value) : value,
      ),
      new Date(atMs),
    ],
  );
  await context.client.query(
    `insert into studio_transitions(world_id,session_id,version,from_phase,to_phase,event,sequence,detail,at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      context.channel.world_id,
      session.id,
      version,
      session.phase,
      to,
      event,
      sequence,
      JSON.stringify(detail),
      new Date(atMs),
    ],
  );
  await context.client.query(
    `update deadlines set status='cancelled',lease_owner=null,lease_until=null where world_id=$1 and channel_id=$2
    and command->>'type'='studioDeadline' and command->>'sessionId'=$3 and status in ('pending','leased')`,
    [context.channel.world_id, context.channel.id, session.id],
  );
  Object.assign(session, patch, { phase: to, version });
  if (!studioHoldsGame(to)) await releaseGame(context, atMs);
}

async function scheduleDeadline(
  context: GameContext,
  session: StudioSessionRow,
  phase: 'CREATING' | 'VOTING' | 'REVIEW',
  dueMs: number,
): Promise<void> {
  const command: GameCommand = {
    type: 'studioDeadline',
    sessionId: session.id,
    phase,
    version: session.version,
    ballotRoundId: operationId(session.id, session.version, 'studio-ballot'),
  };
  await context.client.query(
    `insert into deadlines(world_id,channel_id,id,job_key,command,due_at,remaining_ms)
    values($1,$2,$3,$4,$5,$6,0) on conflict(world_id,channel_id,job_key) do nothing`,
    [
      context.channel.world_id,
      context.channel.id,
      operationId(session.id, session.version, 'studio-deadline'),
      `studio:${session.id}:${session.version}`,
      JSON.stringify(command),
      new Date(dueMs),
    ],
  );
}

/** Pauses through the round checkpoint; committed mutations stay and no observation runs. */
async function holdGame(context: GameContext, atMs: number): Promise<void> {
  const { client, channel, round } = context;
  if (!channel.studio_hold) {
    await client.query('update channels set studio_hold=true where world_id=$1 and id=$2', [
      channel.world_id,
      channel.id,
    ]);
    channel.studio_hold = true;
  }
  if (round === null) return;
  const clock = pauseRoundClock(round.checkpoint.clock, atMs);
  if (clock !== round.checkpoint.clock)
    await saveCheckpoint(context, { ...round.checkpoint, clock });
}
/** Play resumes from the checkpoint; a manual pause or outage still keeps it held. */
async function releaseGame(context: GameContext, atMs: number): Promise<void> {
  const { client, channel, round } = context;
  if (!channel.studio_hold) return;
  await client.query('update channels set studio_hold=false where world_id=$1 and id=$2', [
    channel.world_id,
    channel.id,
  ]);
  channel.studio_hold = false;
  if (
    round === null ||
    !channel.online ||
    !channel.healthy ||
    gameHeld(channel) ||
    round.checkpoint.clock.phase === 'INTERRUPTED'
  )
    return;
  const clock = resumeRoundClock(round.checkpoint.clock, atMs);
  if (clock !== round.checkpoint.clock)
    await saveCheckpoint(context, { ...round.checkpoint, clock });
}

async function setAvailability(
  context: GameContext,
  state: 'ACTIVE' | 'REST' | 'UNKNOWN',
  source: 'manual' | 'bridge' | 'stream' | 'integration',
): Promise<boolean> {
  const changed = await context.client.query(
    `update channel_studio set availability=$3,availability_source=$4 where world_id=$1 and channel_id=$2
    and (availability,availability_source) is distinct from ($3,$4)`,
    [context.channel.world_id, context.channel.id, state, source],
  );
  return changed.rowCount === 1;
}

export async function updateStudioSettings(
  context: GameContext,
  settings: StudioSettings,
): Promise<CommandEffect> {
  const changed = await context.client.query(
    'update channel_studio set settings=$3 where world_id=$1 and channel_id=$2 and settings is distinct from $3::jsonb',
    [
      context.channel.world_id,
      context.channel.id,
      JSON.stringify(studioSettingsSchema.parse(settings)),
    ],
  );
  return changed.rowCount === 1
    ? effect('APPLIED', 'studio.settings_changed', { enabled: settings.enabled })
    : effect('NO_CHANGE');
}

/** Break entry (manual or a configured OBS scene): availability first, then a studio if eligible. */
export async function startStudio(
  context: GameContext,
  command: Extract<GameCommand, { type: 'studioStart' }>,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const studio = await readStudioSettings(context);
  if (!studio.settings.enabled) return effect('STUDIO_DISABLED');
  if (command.trigger === 'bridge' && studio.availability === 'UNKNOWN')
    return effect('STUDIO_UNAVAILABLE', null, { reason: 'availability_unknown' });
  const availabilityChanged = await setAvailability(context, 'REST', command.trigger);
  const notOpened = (code: GameResultCode, reason: string): CommandEffect =>
    availabilityChanged
      ? effect('APPLIED', 'availability.changed', { availability: 'REST', opened: false, reason })
      : effect(code, null, { reason });
  const existing = await activeStudioSession(context);
  const resident = await residentOrganism(context);
  const eligibility = studioOpeningEligibility({
    enabled: true,
    online: context.channel.online,
    healthy: context.channel.healthy,
    status: resident?.status ?? null,
    slots: resident?.mutation_slots ?? null,
    activeSession: existing !== null,
  });
  if (!eligibility.eligible)
    return notOpened(
      eligibility.reason === 'studio_active'
        ? 'STUDIO_ACTIVE'
        : eligibility.reason === 'pending_adaptation_exists'
          ? 'PENDING_ADAPTATION_EXISTS'
          : 'STUDIO_UNAVAILABLE',
      eligibility.reason,
    );
  if (resident === null) throw new Error('Eligible studio without a resident.');
  const challenge = createStudioChallenge(
    {
      worldId: context.channel.world_id,
      studioSessionId: command.sessionId,
      baseOrganismId: resident.id,
      baseOrganismVersion: resident.design_version,
      genome: genomeOf(resident),
      baseAppearanceHash: resident.appearance_hash,
      targetMutationSlot: resident.mutation_slots.next,
    },
    context.rules,
  );
  const cosmeticOnly = challenge.mutationTemplateIds.includes('cosmetic-only');
  if (cosmeticOnly && studio.settings.cosmeticPolicy === 'defer')
    return notOpened('STUDIO_DEFERRED', 'cosmetic_only_deferred');
  const session: StudioSessionRow = {
    id: command.sessionId,
    channel_id: context.channel.id,
    organism_id: resident.id,
    phase: 'OPENING',
    version: 0,
    trigger: command.trigger,
    challenge,
    seed: sha256Hex(canonicalJson([context.channel.seed, 'studio', command.sessionId])),
    settings: studio.settings,
    creation_close_at: null,
    voting_close_at: null,
    review_expires_at: null,
    ballot_round_id: null,
    shortlist: null,
    selection: null,
    adaptation_id: null,
    outcome: null,
  };
  await context.client.query(
    `insert into studio_sessions(world_id,id,channel_id,organism_id,phase,version,trigger,challenge,seed,settings,opened_sequence,created_at)
    values($1,$2,$3,$4,'OPENING',0,$5,$6,$7,$8,$9,$10)`,
    [
      context.channel.world_id,
      session.id,
      context.channel.id,
      resident.id,
      command.trigger,
      JSON.stringify(challenge),
      session.seed,
      JSON.stringify(studio.settings),
      sequence,
      new Date(atMs),
    ],
  );
  await context.client.query(
    `insert into studio_transitions(world_id,session_id,version,from_phase,to_phase,event,sequence,detail,at)
    values($1,$2,0,null,'OPENING','triggered',$3,$4,$5)`,
    [
      context.channel.world_id,
      session.id,
      sequence,
      JSON.stringify({ trigger: command.trigger }),
      new Date(atMs),
    ],
  );
  await holdGame(context, atMs);
  const closeMs = atMs + studio.settings.creationMs;
  await recordStudioTransition(
    context,
    session,
    'captured',
    sequence,
    atMs,
    { cosmeticOnly },
    {
      creation_close_at: new Date(closeMs),
    },
  );
  await scheduleDeadline(context, session, 'CREATING', closeMs);
  return effect('APPLIED', 'studio.opened', {
    sessionId: session.id,
    templates: challenge.mutationTemplateIds,
    targetMutationSlot: challenge.targetMutationSlot,
  });
}

/** End break: creation stops and drafts stay unapplied; voting follows the configured policy. */
export async function returnFromStudio(
  context: GameContext,
  command: Extract<GameCommand, { type: 'studioReturn' }>,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const studio = await readStudioSettings(context);
  if (
    command.trigger === 'bridge' &&
    (!studio.settings.enabled || studio.availability === 'UNKNOWN')
  )
    return effect('STUDIO_UNAVAILABLE', null, { reason: 'availability_unknown' });
  const availabilityChanged = await setAvailability(context, 'ACTIVE', command.trigger);
  const session = await activeStudioSession(context);
  if (session !== null && (session.phase === 'OPENING' || session.phase === 'CREATING')) {
    await recordStudioTransition(
      context,
      session,
      'host_returned',
      sequence,
      atMs,
      { trigger: command.trigger },
      {
        outcome: { reason: 'host_returned' },
      },
    );
    return effect('APPLIED', 'studio.cancelled', {
      sessionId: session.id,
      reason: 'host_returned',
    });
  }
  if (session?.phase === 'VOTING' && session.settings.returnDuringVoting === 'cancel') {
    await closeBallotRound(context, session, sequence, atMs, null);
    await recordStudioTransition(
      context,
      session,
      'host_cancelled',
      sequence,
      atMs,
      { policy: 'cancel' },
      {
        outcome: { reason: 'host_returned_during_voting' },
      },
    );
    return effect('APPLIED', 'studio.cancelled', {
      sessionId: session.id,
      reason: 'host_returned_during_voting',
    });
  }
  return availabilityChanged
    ? effect('APPLIED', 'availability.changed', {
        availability: 'ACTIVE',
        ...(session === null ? {} : { sessionId: session.id, phase: session.phase }),
      })
    : effect('NO_CHANGE');
}

/** Only configured scenes on an enabled channel count; everything else is ignored. */
export async function applyBridgeScene(
  context: GameContext,
  command: Extract<GameCommand, { type: 'bridgeScene' }>,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const studio = await readStudioSettings(context);
  await context.client.query(
    'update channel_studio set bridge_scene=$3,bridge_stale=false where world_id=$1 and channel_id=$2',
    [context.channel.world_id, context.channel.id, command.scene],
  );
  const staleCleared = studio.bridge_stale;
  if (!studio.settings.enabled) return effect('STUDIO_DISABLED');
  if (studio.settings.breakScenes.includes(command.scene)) {
    if (studio.availability === 'REST' && studio.availability_source !== null) {
      const session = await activeStudioSession(context);
      if (session !== null)
        return staleCleared
          ? effect('APPLIED', 'availability.changed', { bridgeStale: false })
          : effect('NO_CHANGE');
    }
    return startStudio(
      context,
      { type: 'studioStart', trigger: 'bridge', sessionId: command.sessionId },
      sequence,
      atMs,
    );
  }
  if (studio.settings.activeScenes.includes(command.scene))
    return returnFromStudio(context, { type: 'studioReturn', trigger: 'bridge' }, sequence, atMs);
  return staleCleared
    ? effect('APPLIED', 'availability.changed', { bridgeStale: false })
    : effect('NO_CHANGE', null, { ignoredScene: true });
}

/** A hidden or closed bridge makes the signal stale; it never implies the streamer returned. */
export async function markBridgeStale(context: GameContext): Promise<CommandEffect> {
  const changed = await context.client.query(
    'update channel_studio set bridge_stale=true where world_id=$1 and channel_id=$2 and not bridge_stale',
    [context.channel.world_id, context.channel.id],
  );
  return changed.rowCount === 1
    ? effect('APPLIED', 'availability.changed', { bridgeStale: true })
    : effect('NO_CHANGE');
}

/**
 * Broadcast and input health changes. Offline closes creation and voting without fabricating a
 * result; review and pending results stay for explicit recovery. Lost input health is UNKNOWN.
 */
export async function studioOnIntegration(
  context: GameContext,
  previous: { online: boolean; healthy: boolean },
  sequence: number,
  atMs: number,
): Promise<boolean> {
  const { channel } = context;
  let changed = false;
  if (previous.healthy && !channel.healthy)
    changed = (await setAvailability(context, 'UNKNOWN', 'integration')) || changed;
  if (!previous.healthy && channel.healthy) {
    const session = await activeStudioSession(context);
    changed =
      (await setAvailability(
        context,
        session !== null && studioHoldsGame(session.phase) ? 'REST' : 'ACTIVE',
        'integration',
      )) || changed;
  }
  if (previous.online && !channel.online) {
    const session = await activeStudioSession(context);
    if (
      session !== null &&
      (session.phase === 'OPENING' || session.phase === 'CREATING' || session.phase === 'VOTING')
    ) {
      if (session.phase === 'VOTING')
        await closeBallotRound(context, session, sequence, atMs, null);
      await recordStudioTransition(
        context,
        session,
        'offline',
        sequence,
        atMs,
        {},
        {
          outcome: { reason: 'stream_offline' },
        },
      );
      changed = true;
    }
  }
  return changed;
}

async function closeBallotRound(
  context: GameContext,
  session: StudioSessionRow,
  sequence: number,
  atMs: number,
  counts: number[] | null,
): Promise<void> {
  if (session.ballot_round_id === null) return;
  await context.client.query(
    `update rounds set phase='COMPLETE',completed_at=$3,close_sequence=$4,
    checkpoint=jsonb_set(jsonb_set(checkpoint,'{clock}',jsonb_build_object('phase','COMPLETE','deadlineAtMs',null)),'{counts}',coalesce($5::jsonb,checkpoint->'counts'))
    where world_id=$1 and id=$2 and completed_at is null`,
    [
      context.channel.world_id,
      session.ballot_round_id,
      new Date(atMs),
      sequence,
      counts === null ? null : JSON.stringify(counts),
    ],
  );
}

interface ProposalRow {
  id: string;
  artist_key: string;
  credit: string;
  credit_opt_in: boolean;
  revision: number;
  blueprint_hash: string;
  status: string;
  submitted_at: Date;
}

/** Validates the untrusted blueprint against the captured challenge before storing it. */
export async function submitProposal(
  context: GameContext,
  command: Extract<GameCommand, { type: 'studioProposal' }>,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const { client, channel } = context;
  const session = await sessionById(context, command.sessionId);
  if (session === null) return effect('STUDIO_WRONG_PHASE', null, { reason: 'unknown_session' });
  const duplicate = await client.query(
    'select 1 from studio_proposals where world_id=$1 and id=$2',
    [channel.world_id, command.proposalId],
  );
  if (duplicate.rowCount === 1)
    return effect('NO_CHANGE', null, { proposalId: command.proposalId });
  if (session.phase !== 'CREATING')
    return effect('STUDIO_WRONG_PHASE', null, { phase: session.phase });
  const blocked = await client.query(
    'select 1 from studio_artist_blocks where world_id=$1 and channel_id=$2 and artist_key=$3',
    [channel.world_id, channel.id, command.artistKey],
  );
  if (blocked.rowCount === 1) return effect('ARTIST_BLOCKED');
  if (new TextEncoder().encode(JSON.stringify(command.blueprint)).length > MAX_BLUEPRINT_BYTES)
    return effect('INVALID_BLUEPRINT', null, { reason: 'payload_too_large' });
  let accepted;
  try {
    accepted = acceptBlueprint(
      command.blueprint,
      studioChallengeSchema.parse(session.challenge),
      context.rules,
    );
  } catch (error) {
    if (error instanceof StudioRuleError)
      return effect(studioResultCode(error), null, { reason: error.message });
    throw error;
  }
  const previous = (
    await client.query<ProposalRow>(
      "select * from studio_proposals where world_id=$1 and session_id=$2 and artist_key=$3 and status='active' for update",
      [channel.world_id, session.id, command.artistKey],
    )
  ).rows[0];
  if (
    previous !== undefined &&
    previous.submitted_at.getTime() + session.settings.replaceCooldownMs > atMs
  )
    return effect('PROPOSAL_RATE_LIMITED', null, {
      retryAtMs: previous.submitted_at.getTime() + session.settings.replaceCooldownMs,
    });
  if (previous === undefined) {
    const count =
      (
        await client.query<{ count: number }>(
          "select count(*)::int as count from studio_proposals where world_id=$1 and session_id=$2 and status='active'",
          [channel.world_id, session.id],
        )
      ).rows[0]?.count ?? 0;
    if (count >= session.settings.maxProposals)
      return effect('PROPOSAL_LIMIT_REACHED', null, { limit: session.settings.maxProposals });
  }
  await client.query(
    `insert into appearance_blueprints(world_id,hash,canonical,blueprint,renderer_version,template,session_id,parent_hash,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(world_id,hash) do nothing`,
    [
      channel.world_id,
      accepted.hash,
      accepted.canonical,
      accepted.canonical,
      accepted.blueprint.rendererVersion,
      accepted.blueprint.mutationTemplateId,
      session.id,
      session.challenge.baseAppearanceHash,
      new Date(atMs),
    ],
  );
  if (previous !== undefined)
    await client.query(
      "update studio_proposals set status='replaced',ended_sequence=$3 where world_id=$1 and id=$2",
      [channel.world_id, previous.id, sequence],
    );
  await client.query(
    `insert into studio_proposals(world_id,id,session_id,artist_key,credit,credit_opt_in,revision,blueprint_hash,status,submitted_sequence,submitted_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10)`,
    [
      channel.world_id,
      command.proposalId,
      session.id,
      command.artistKey,
      command.credit,
      command.creditOptIn,
      (previous?.revision ?? 0) + 1,
      accepted.hash,
      sequence,
      new Date(atMs),
    ],
  );
  return effect('APPLIED', 'studio.proposals_changed', {
    sessionId: session.id,
    proposalId: command.proposalId,
    hash: accepted.hash,
    replaced: previous?.id ?? null,
  });
}

export async function withdrawProposal(
  context: GameContext,
  command: Extract<GameCommand, { type: 'studioWithdraw' | 'studioRemoveProposal' }>,
  sequence: number,
): Promise<CommandEffect> {
  const session = await sessionById(context, command.sessionId);
  if (session?.phase !== 'CREATING')
    return effect('STUDIO_WRONG_PHASE', null, { phase: session?.phase ?? null });
  const changed = await context.client.query(
    `update studio_proposals set status=$5,ended_sequence=$6 where world_id=$1 and session_id=$2 and id=$3
    and status='active' and ($4::text is null or artist_key=$4)`,
    [
      context.channel.world_id,
      session.id,
      command.proposalId,
      command.type === 'studioWithdraw' ? command.artistKey : null,
      command.type === 'studioWithdraw' ? 'withdrawn' : 'removed',
      sequence,
    ],
  );
  return changed.rowCount === 1
    ? effect('APPLIED', 'studio.proposals_changed', {
        sessionId: session.id,
        proposalId: command.proposalId,
        [command.type === 'studioWithdraw' ? 'withdrawn' : 'removed']: true,
      })
    : effect('NO_CHANGE');
}

/** Blocking also removes the artist's active proposal in a still-open studio. */
export async function blockArtist(
  context: GameContext,
  command: Extract<GameCommand, { type: 'studioBlockArtist' }>,
  sequence: number,
): Promise<CommandEffect> {
  const { client, channel } = context;
  const changed = command.blocked
    ? await client.query(
        'insert into studio_artist_blocks(world_id,channel_id,artist_key) values($1,$2,$3) on conflict do nothing',
        [channel.world_id, channel.id, command.artistKey],
      )
    : await client.query(
        'delete from studio_artist_blocks where world_id=$1 and channel_id=$2 and artist_key=$3',
        [channel.world_id, channel.id, command.artistKey],
      );
  if (command.blocked)
    await client.query(
      `update studio_proposals p set status='removed',ended_sequence=$4 from studio_sessions s
      where p.world_id=$1 and s.world_id=p.world_id and s.id=p.session_id and s.channel_id=$2 and s.phase='CREATING'
      and p.artist_key=$3 and p.status='active'`,
      [channel.world_id, channel.id, command.artistKey, sequence],
    );
  return changed.rowCount === 1
    ? effect('APPLIED', 'studio.artist_block_changed', { blocked: command.blocked })
    : effect('NO_CHANGE');
}

export async function openStudioBallot(context: GameContext): Promise<StudioSessionRow | null> {
  const session = await activeStudioSession(context);
  return session?.phase === 'VOTING' && session.ballot_round_id !== null ? session : null;
}

/** Chat votes reuse the round vote table: one accepted vote per account, recorded in order. */
export async function acceptStudioVote(
  context: GameContext,
  session: StudioSessionRow,
  actorKey: string,
  choice: number,
  sequence: number,
): Promise<CommandEffect> {
  const { client, channel } = context;
  if (!channel.online || !channel.healthy || session.ballot_round_id === null)
    return effect('NO_ACTIVE_BALLOT');
  const ballot = (
    await client.query<{ checkpoint: StudioBallotCheckpoint }>(
      'select checkpoint from rounds where world_id=$1 and id=$2 and completed_at is null for update',
      [channel.world_id, session.ballot_round_id],
    )
  ).rows[0];
  if (ballot === undefined || choice > ballot.checkpoint.studioBallot.options)
    return effect('NO_ACTIVE_BALLOT');
  const inserted = await client.query(
    'insert into votes(world_id,channel_id,round_id,actor_key,choice,accepted_sequence) values($1,$2,$3,$4,$5,$6) on conflict do nothing',
    [channel.world_id, channel.id, session.ballot_round_id, actorKey, choice, sequence],
  );
  if (inserted.rowCount === 0) return effect('ALREADY_VOTED');
  const counts = [...ballot.checkpoint.counts];
  counts[choice - 1] = (counts[choice - 1] ?? 0) + 1;
  await client.query(
    `update rounds set checkpoint=jsonb_set(checkpoint,'{counts}',$3::jsonb),vote_count=vote_count+1 where world_id=$1 and id=$2`,
    [channel.world_id, session.ballot_round_id, JSON.stringify(counts)],
  );
  return effect('APPLIED', 'vote.aggregate', {
    roundId: session.ballot_round_id,
    counts,
    studio: true,
  });
}

async function finalistsOf(
  context: GameContext,
  session: StudioSessionRow,
): Promise<StudioFinalist[]> {
  const stored = session.shortlist?.finalists ?? [];
  const rows = (
    await context.client.query<{ hash: string; canonical: string; blueprint: AppearanceBlueprint }>(
      'select hash,canonical,blueprint from appearance_blueprints where world_id=$1 and hash=any($2)',
      [context.channel.world_id, stored.map((item) => item.hash)],
    )
  ).rows;
  return stored.map((item) => {
    const row = rows.find((candidate) => candidate.hash === item.hash);
    if (row === undefined) throw new Error('Missing recorded studio finalist.');
    return {
      proposalId: item.proposalId,
      hash: row.hash,
      canonical: row.canonical,
      blueprint: blueprintSchema.parse(row.blueprint),
    };
  });
}

/** Durable creation close, voting close and review expiry. Stale versions change nothing. */
export async function applyStudioDeadline(
  context: GameContext,
  command: Extract<GameCommand, { type: 'studioDeadline' }>,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const session = await sessionById(context, command.sessionId);
  if (session?.version !== command.version || session.phase !== command.phase)
    return effect('STALE_VERSION');
  if (session.phase === 'CREATING')
    return closeCreation(context, session, command.ballotRoundId, sequence, atMs);
  if (session.phase === 'VOTING') return closeVoting(context, session, sequence, atMs);
  await recordStudioTransition(
    context,
    session,
    'review_expired',
    sequence,
    atMs,
    {},
    {
      outcome: { reason: 'review_expired' },
    },
  );
  return effect('APPLIED', 'studio.phase_changed', { sessionId: session.id, phase: 'EXPIRED' });
}

async function closeCreation(
  context: GameContext,
  session: StudioSessionRow,
  ballotRoundId: string,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const { client, channel } = context;
  if (!channel.online || !channel.healthy) {
    await recordStudioTransition(
      context,
      session,
      'creation_unavailable',
      sequence,
      atMs,
      {},
      {
        outcome: { reason: 'chat_unavailable' },
      },
    );
    return effect('APPLIED', 'studio.phase_changed', { sessionId: session.id, phase: 'EXPIRED' });
  }
  const proposals = (
    await client.query<{
      id: string;
      artist_key: string;
      credit: string;
      credit_opt_in: boolean;
      blueprint: unknown;
    }>(
      `select p.id,p.artist_key,p.credit,p.credit_opt_in,b.blueprint from studio_proposals p
      join appearance_blueprints b on b.world_id=p.world_id and b.hash=p.blueprint_hash
      where p.world_id=$1 and p.session_id=$2 and p.status='active' order by p.id`,
      [channel.world_id, session.id],
    )
  ).rows;
  const shortlist = shortlistStudioProposals(
    proposals.map((p) => ({ id: p.id, artistKey: p.artist_key, blueprint: p.blueprint })),
    studioChallengeSchema.parse(session.challenge),
    session.seed,
    context.rules,
  );
  const stored = {
    finalists: shortlist.finalists.map((finalist) => {
      const proposal = proposals.find((p) => p.id === finalist.proposalId);
      return {
        proposalId: finalist.proposalId,
        hash: finalist.hash,
        template: finalist.blueprint.mutationTemplateId,
        credit: proposal?.credit_opt_in === true ? proposal.credit : channelCredit(context),
        artistCredit: proposal?.credit_opt_in === true ? proposal.credit : null,
      };
    }),
    rejected: [...shortlist.rejected],
  };
  if (stored.finalists.length === 0) {
    await recordStudioTransition(
      context,
      session,
      'creation_closed',
      sequence,
      atMs,
      { finalists: 0 },
      { shortlist: stored },
    );
    const selection: StoredSelection = {
      kind: 'keep_current',
      reason: 'no_proposals',
      finalistIndex: null,
      counts: [0],
      totalVotes: 0,
    };
    await recordStudioTransition(
      context,
      session,
      'selection_keep_current',
      sequence,
      atMs,
      { reason: 'no_proposals' },
      {
        selection,
        outcome: { reason: 'keep_current' },
      },
    );
    return effect('APPLIED', 'studio.selection_resolved', { sessionId: session.id, selection });
  }
  const closesAt = atMs + session.settings.votingMs;
  const number = (
    await client.query<{ number: number }>(
      'select coalesce(max(number),0)+1 as number from rounds where world_id=$1 and channel_id=$2',
      [channel.world_id, channel.id],
    )
  ).rows[0]?.number;
  if (number === undefined) throw new Error('Cannot allocate studio ballot number.');
  const checkpoint: StudioBallotCheckpoint = {
    schemaVersion: 1,
    studioBallot: { sessionId: session.id, options: stored.finalists.length + 1 },
    counts: Array.from({ length: stored.finalists.length + 1 }, () => 0),
    clock: { phase: 'VOTING', deadlineAtMs: closesAt },
  };
  await client.query(
    `insert into rounds(world_id,id,channel_id,organism_id,number,kind,phase,rules_hash,seed,checkpoint,opened_at)
    values($1,$2,$3,$4,$5,'STUDIO_SELECTION','VOTING',$6,$7,$8,$9)`,
    [
      channel.world_id,
      ballotRoundId,
      channel.id,
      session.organism_id,
      number,
      channel.rules_hash,
      session.seed,
      JSON.stringify(checkpoint),
      new Date(atMs),
    ],
  );
  await recordStudioTransition(
    context,
    session,
    'creation_closed',
    sequence,
    atMs,
    { finalists: stored.finalists.length },
    {
      shortlist: stored,
      ballot_round_id: ballotRoundId,
      voting_close_at: new Date(closesAt),
    },
  );
  await scheduleDeadline(context, session, 'VOTING', closesAt);
  return effect('APPLIED', 'studio.shortlist_ready', {
    sessionId: session.id,
    ballotRoundId,
    finalists: stored.finalists.map((item) => item.hash),
  });
}

function channelCredit(context: GameContext): string {
  return context.channel.label.slice(0, 40);
}

async function closeVoting(
  context: GameContext,
  session: StudioSessionRow,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const { client, channel } = context;
  const votes = (
    await client.query<{ actor_key: string; choice: number }>(
      'select actor_key,choice from votes where world_id=$1 and round_id=$2 order by accepted_sequence',
      [channel.world_id, session.ballot_round_id],
    )
  ).rows.map((vote): BallotVote => ({ actorKey: vote.actor_key, choice: vote.choice }));
  const finalists = await finalistsOf(context, session);
  const { tally, outcome } = resolveStudioSelection(finalists, votes);
  await closeBallotRound(context, session, sequence, atMs, [...tally.counts]);
  const dormant =
    context.mechanics.version === 1
      ? studioDormantFinalist(
          finalists,
          tally,
          outcome.kind === 'design' ? outcome.finalist.blueprint : null,
          context.rules,
        )
      : null;
  const dormantMove =
    dormant === null ? null : studioMutationMove(dormant.blueprint.mutationTemplateId);
  const captured =
    dormant === null || dormantMove === null || session.ballot_round_id === null
      ? null
      : await captureStudioDormant(
          context,
          {
            sessionId: session.id,
            ballotRoundId: session.ballot_round_id,
            organismId: session.organism_id,
            move: dormantMove,
            blueprintHash: dormant.hash,
            supporters: tally.counts[finalists.indexOf(dormant)] ?? 0,
            totalVotes: tally.totalVotes,
          },
          sequence,
        );
  const finalistIndex =
    outcome.kind === 'design'
      ? finalists.findIndex((item) => item.proposalId === outcome.finalist.proposalId) + 1
      : null;
  const selection: StoredSelection = {
    kind: outcome.kind,
    reason: outcome.kind === 'keep_current' ? outcome.reason : null,
    finalistIndex,
    counts: [...tally.counts],
    totalVotes: tally.totalVotes,
    ...(captured === null ? {} : { dormantId: captured.capturedId }),
  };
  if (outcome.kind === 'keep_current') {
    await recordStudioTransition(
      context,
      session,
      'selection_keep_current',
      sequence,
      atMs,
      { reason: outcome.reason },
      {
        selection,
        outcome: { reason: 'keep_current' },
      },
    );
    return effect('APPLIED', 'studio.selection_resolved', { sessionId: session.id, selection });
  }
  if (session.settings.approval === 'auto') {
    session.selection = selection;
    return approve(
      context,
      session,
      operationId(session.id, sequence, 'studio-adaptation'),
      'automatic',
      'selection_auto_approved',
      sequence,
      atMs,
      { selection },
    );
  }
  const expiresAt = atMs + session.settings.reviewMs;
  await recordStudioTransition(
    context,
    session,
    'selection_review',
    sequence,
    atMs,
    { finalistIndex },
    {
      selection,
      review_expires_at: new Date(expiresAt),
    },
  );
  await scheduleDeadline(context, session, 'REVIEW', expiresAt);
  return effect('APPLIED', 'studio.review_required', { sessionId: session.id, selection });
}

/**
 * Approval revalidates the captured base and reserves the next slot. An open ordinary ballot for
 * that same slot becomes the hatch boundary, so the design replaces its cards rather than adding
 * a second change. Play then resumes from the round checkpoint.
 */
async function approve(
  context: GameContext,
  session: StudioSessionRow,
  adaptationId: string,
  approvedBy: 'broadcaster' | 'automatic',
  event: 'approved' | 'selection_auto_approved',
  sequence: number,
  atMs: number,
  patch: SessionPatch = {},
): Promise<CommandEffect> {
  const { client, channel } = context;
  const index = session.selection?.finalistIndex ?? null;
  const finalist = index === null ? undefined : (await finalistsOf(context, session))[index - 1];
  if (finalist === undefined) throw new Error('Approval without a recorded winning finalist.');
  const organism = await organismById(context, session.organism_id);
  let approved;
  try {
    approved = approveStudioAdaptation(
      adaptationId,
      finalist.blueprint,
      studioChallengeSchema.parse(session.challenge),
      {
        id: organism.id,
        version: organism.design_version,
        genome: genomeOf(organism),
        status: organism.status,
        appearanceHash: organism.appearance_hash,
        appearance: null,
      },
      organism.mutation_slots,
      context.rules,
    );
  } catch (error) {
    if (!(error instanceof StudioRuleError)) throw error;
    await recordStudioTransition(
      context,
      session,
      'base_invalid',
      sequence,
      atMs,
      { code: error.code },
      {
        ...patch,
        outcome: { reason: error.code },
      },
    );
    return effect(studioResultCode(error), 'studio.cancelled', {
      sessionId: session.id,
      reason: error.code,
    });
  }
  const stored = session.shortlist?.finalists[(index ?? 1) - 1];
  await client.query(
    `insert into pending_adaptations(world_id,id,session_id,channel_id,organism_id,blueprint_hash,template,target_slot,status,approval,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10)`,
    [
      channel.world_id,
      adaptationId,
      session.id,
      channel.id,
      organism.id,
      finalist.hash,
      finalist.blueprint.mutationTemplateId,
      session.challenge.targetMutationSlot,
      JSON.stringify({
        by: approvedBy,
        sequence,
        channelCredit: channelCredit(context),
        artistCredit: stored?.artistCredit ?? null,
      }),
      new Date(atMs),
    ],
  );
  await saveSlots(context, organism.id, approved.slots);
  await recordStudioTransition(
    context,
    session,
    event,
    sequence,
    atMs,
    { adaptationId, approvedBy },
    {
      ...patch,
      adaptation_id: adaptationId,
    },
  );
  await convertOpenBallotToHatch(context, session, adaptationId, finalist.hash);
  return effect('APPLIED', 'studio.adaptation_pending', {
    sessionId: session.id,
    adaptationId,
    hash: finalist.hash,
    targetMutationSlot: session.challenge.targetMutationSlot,
  });
}

async function saveSlots(
  context: GameContext,
  organismId: string,
  slots: MutationSlots,
): Promise<void> {
  await context.client.query('update organisms set mutation_slots=$3 where world_id=$1 and id=$2', [
    context.channel.world_id,
    organismId,
    JSON.stringify(slots),
  ]);
  if (context.organism?.id === organismId)
    context.organism = { ...context.organism, mutation_slots: slots };
}

async function convertOpenBallotToHatch(
  context: GameContext,
  session: StudioSessionRow,
  adaptationId: string,
  hash: string,
): Promise<void> {
  const round = context.round;
  const phase =
    round?.checkpoint.clock.phase === 'INTERRUPTED'
      ? round.checkpoint.clock.interruptedPhase
      : round?.checkpoint.clock.phase;
  if (
    round === null ||
    phase !== 'VOTING' ||
    round.organism_id !== session.organism_id ||
    round.checkpoint.specialBallot !== undefined ||
    round.checkpoint.studioHatch !== undefined
  )
    return;
  await saveCheckpoint(context, {
    ...round.checkpoint,
    studioHatch: { adaptationId, sessionId: session.id, hash },
  });
}

export async function reviewStudio(
  context: GameContext,
  command: Extract<GameCommand, { type: 'studioReview' }>,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const session = await sessionById(context, command.sessionId);
  if (session === null) return effect('STUDIO_WRONG_PHASE');
  if (session.phase === 'EXPIRED' && session.outcome?.reason === 'review_expired')
    return effect('REVIEW_EXPIRED');
  if (session.phase !== 'REVIEW')
    return effect('STUDIO_WRONG_PHASE', null, { phase: session.phase });
  if (session.version !== command.sessionVersion) return effect('STALE_VERSION');
  if (command.decision === 'keep') {
    await recordStudioTransition(
      context,
      session,
      'rejected',
      sequence,
      atMs,
      {},
      {
        outcome: { reason: 'broadcaster_kept_current' },
      },
    );
    return effect('APPLIED', 'studio.cancelled', {
      sessionId: session.id,
      reason: 'broadcaster_kept_current',
    });
  }
  return approve(context, session, command.adaptationId, 'broadcaster', 'approved', sequence, atMs);
}

/** Explicit recovery: the broadcaster may release a pending result before its hatch begins. */
export async function releasePendingAdaptation(
  context: GameContext,
  command: Extract<GameCommand, { type: 'studioRelease' }>,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const session = await sessionById(context, command.sessionId);
  if (session?.phase !== 'PENDING_HATCH') return effect('STUDIO_WRONG_PHASE');
  if (session.version !== command.sessionVersion) return effect('STALE_VERSION');
  if (context.round?.checkpoint.studioHatch?.sessionId === session.id)
    return effect('STUDIO_WRONG_PHASE', null, { reason: 'hatch_in_progress' });
  await resolvePending(context, session, 'released', 'broadcaster_released', sequence, atMs);
  return effect('APPLIED', 'studio.cancelled', {
    sessionId: session.id,
    reason: 'broadcaster_released',
  });
}

async function resolvePending(
  context: GameContext,
  session: StudioSessionRow,
  status: 'released' | 'cancelled',
  reason: string,
  sequence: number,
  atMs: number,
): Promise<void> {
  if (session.adaptation_id !== null) {
    await context.client.query(
      "update pending_adaptations set status=$3,reason=$4,resolved_at=$5 where world_id=$1 and id=$2 and status='pending'",
      [context.channel.world_id, session.adaptation_id, status, reason, new Date(atMs)],
    );
    const organism = await organismById(context, session.organism_id);
    await saveSlots(
      context,
      organism.id,
      releaseMutationSlot(organism.mutation_slots, session.adaptation_id),
    );
  }
  await recordStudioTransition(
    context,
    session,
    status === 'released' ? 'released' : 'organism_fossilized',
    sequence,
    atMs,
    { reason },
    { outcome: { reason } },
  );
}

/** A branch that becomes a fossil cancels its studio and any pending adaptation. */
export async function cancelStudioForInactive(
  context: GameContext,
  sequence: number,
  atMs: number,
): Promise<boolean> {
  const session = await activeStudioSession(context);
  if (session === null) return false;
  const organism = await organismById(context, session.organism_id);
  if (organism.status === 'ALIVE') return false;
  if (session.phase === 'VOTING') await closeBallotRound(context, session, sequence, atMs, null);
  if (session.phase === 'PENDING_HATCH')
    await resolvePending(context, session, 'cancelled', 'organism_fossilized', sequence, atMs);
  else
    await recordStudioTransition(
      context,
      session,
      'organism_fossilized',
      sequence,
      atMs,
      {},
      {
        outcome: { reason: 'organism_fossilized' },
      },
    );
  return true;
}

/** True while a studio phase rather than the ordinary round owns the channel's ballot. */
export function studioHoldsBallots(session: StudioSessionRow | null): boolean {
  return session !== null && studioHoldsGame(session.phase);
}
