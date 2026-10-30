import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  defaultStudioSettings,
  founderShell,
  type StudioChallenge,
  type StudioSettings,
} from '@ripple/contracts';
import {
  applyMove,
  candidateRuleset,
  studioMutationMove,
  type MutationSlots,
  type RoundCheckpoint,
} from '@ripple/engine';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { readSnapshot } from './snapshot.ts';

const artist = (name: string) => createHash('sha256').update(name).digest('hex');
const settings: StudioSettings = {
  ...defaultStudioSettings,
  enabled: true,
  breakScenes: ['Be right back'],
  activeScenes: ['Main'],
  creationMs: 10_000,
  votingMs: 10_000,
  reviewMs: 60_000,
  replaceCooldownMs: 5_000,
};

describe('Cocoon Studio lifecycle on the ordered worker', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool;
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
  });
  afterAll(async () => {
    await pool.end();
    await temporary.drop();
  });
  async function send(world: SyntheticWorld, value: unknown) {
    const accepted = await acceptSyntheticCommand(
      pool,
      world,
      world.ownerCapability,
      randomUUID(),
      value,
    );
    await settleSyntheticWorld(pool, world);
    const event = (
      await pool.query<{
        result: { code: string; updateType: string | null; detail: Record<string, unknown> };
      }>('select result from game_events where world_id=$1 and channel_id=$2 and sequence=$3', [
        world.worldId,
        world.channelId,
        accepted.sequence,
      ])
    ).rows[0];
    return event?.result;
  }
  async function advance(world: SyntheticWorld, ms: number) {
    await advanceSyntheticClock(pool, world, world.ownerCapability, randomUUID(), ms);
  }
  async function world(overrides: Partial<StudioSettings> = {}) {
    const created = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(created, syntheticSeedCommand());
    expect(
      await send(created, { type: 'studioSettings', settings: { ...settings, ...overrides } }),
    ).toMatchObject({
      code: 'APPLIED',
    });
    return created;
  }
  async function session(scope: SyntheticWorld) {
    return (
      await pool.query<{
        id: string;
        phase: string;
        version: number;
        challenge: StudioChallenge;
        selection: { kind: string; finalistIndex: number | null } | null;
        shortlist: { finalists: { hash: string; template: string }[] } | null;
        outcome: { reason: string } | null;
      }>(
        'select * from studio_sessions where world_id=$1 and channel_id=$2 order by created_at desc limit 1',
        [scope.worldId, scope.channelId],
      )
    ).rows[0]!;
  }
  async function organism(scope: SyntheticWorld) {
    return (
      await pool.query<{
        id: string;
        pulse: number;
        calm: number;
        grit: number;
        drift: number;
        design_version: number;
        appearance_hash: string | null;
        appearance: { kind: string };
        mutation_slots: MutationSlots;
      }>(
        `select o.* from organisms o join residencies r on r.world_id=o.world_id and r.organism_id=o.id
        where r.world_id=$1 and r.channel_id=$2 and r.role='resident' and r.ended_at is null`,
        [scope.worldId, scope.channelId],
      )
    ).rows[0]!;
  }
  async function openRound(scope: SyntheticWorld) {
    return (
      await pool.query<{ id: string; kind: string; checkpoint: RoundCheckpoint }>(
        "select id,kind,checkpoint from rounds where world_id=$1 and channel_id=$2 and completed_at is null and kind<>'STUDIO_SELECTION'",
        [scope.worldId, scope.channelId],
      )
    ).rows[0];
  }
  function design(
    challenge: StudioChallenge,
    template = challenge.mutationTemplateIds[0],
    width = 620,
  ) {
    return {
      schemaVersion: 1,
      worldId: challenge.worldId,
      studioSessionId: challenge.studioSessionId,
      baseOrganismId: challenge.baseOrganismId,
      baseOrganismVersion: challenge.baseOrganismVersion,
      mutationTemplateId: template,
      rendererVersion: 'shell-v1',
      part: { ...founderShell, parameters: { ...founderShell.parameters, width } },
    };
  }
  function propose(challenge: StudioChallenge, name: string, value: unknown = design(challenge)) {
    return {
      type: 'studioProposal',
      sessionId: challenge.studioSessionId,
      proposalId: randomUUID(),
      artistKey: artist(name),
      credit: name,
      creditOptIn: name === 'ana',
      blueprint: value,
    };
  }

  it('opens during an ordinary ballot, holds the game, selects by chat, and hatches once at that slot', async () => {
    const scope = await world();
    const before = await organism(scope);
    const ballot = await openRound(scope);
    expect(ballot?.checkpoint.clock.phase).toBe('VOTING');
    expect(
      await send(scope, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() }),
    ).toMatchObject({
      code: 'APPLIED',
      updateType: 'studio.opened',
    });
    const opened = await session(scope);
    expect(opened.phase).toBe('CREATING');
    expect(opened.challenge.targetMutationSlot).toBe(before.mutation_slots.next);
    // The ordinary ballot is held at its checkpoint; its cards cannot take votes meanwhile.
    expect((await openRound(scope))?.checkpoint.clock.paused).toBe(true);
    expect(await send(scope, { type: 'vote', actorKey: 'held', choice: 1 })).toMatchObject({
      code: 'NO_ACTIVE_BALLOT',
    });
    expect(await send(scope, { type: 'activity', actorKey: 'studio-chat' })).toMatchObject({
      code: 'NO_CHANGE',
    });

    const [first, second] = opened.challenge.mutationTemplateIds;
    expect(
      await send(scope, propose(opened.challenge, 'ana', design(opened.challenge, first, 700))),
    ).toMatchObject({
      code: 'APPLIED',
    });
    expect(
      await send(scope, propose(opened.challenge, 'ben', design(opened.challenge, second, 500))),
    ).toMatchObject({
      code: 'APPLIED',
    });
    // Replacement is bounded in frequency; untrusted extra fields and illegal templates are refused.
    expect(
      await send(scope, propose(opened.challenge, 'ben', design(opened.challenge, second, 520))),
    ).toMatchObject({
      code: 'PROPOSAL_RATE_LIMITED',
    });
    expect(
      await send(
        scope,
        propose(opened.challenge, 'cy', { ...design(opened.challenge), genome: { grit: 15 } }),
      ),
    ).toMatchObject({ code: 'INVALID_BLUEPRINT' });
    expect(
      await send(scope, propose(opened.challenge, 'cy', design(opened.challenge, 'cosmetic-only'))),
    ).toMatchObject({ code: 'MUTATION_NOT_LEGAL' });
    await advance(scope, 5_000);
    expect(
      await send(scope, propose(opened.challenge, 'ben', design(opened.challenge, second, 540))),
    ).toMatchObject({
      code: 'APPLIED',
    });

    await advance(scope, 5_000);
    const voting = await session(scope);
    expect(voting.phase).toBe('VOTING');
    expect(voting.shortlist?.finalists).toHaveLength(2);
    expect(new Set(voting.shortlist?.finalists.map((item) => item.template)).size).toBe(2);
    const anaIndex = voting.shortlist!.finalists.findIndex((item) => item.template === first) + 1;
    for (const actorKey of ['v1', 'v2', 'v3'])
      expect(await send(scope, { type: 'vote', actorKey, choice: anaIndex })).toMatchObject({
        code: 'APPLIED',
        updateType: 'vote.aggregate',
      });
    expect(await send(scope, { type: 'vote', actorKey: 'v1', choice: 3 })).toMatchObject({
      code: 'ALREADY_VOTED',
    });
    const view = (await readSnapshot(pool, scope.worldId, scope.channelId))!.payload.studio;
    expect(view.session?.finalists.map((item) => item.index)).toEqual([1, 2]);
    expect(view.session?.counts[anaIndex - 1]).toBe(3);

    await advance(scope, 10_000);
    const review = await session(scope);
    expect(review).toMatchObject({
      phase: 'REVIEW',
      selection: { kind: 'design', finalistIndex: anaIndex },
    });
    expect((await openRound(scope))?.checkpoint.clock.paused).toBe(true);
    const adaptationId = randomUUID();
    expect(
      await send(scope, {
        type: 'studioReview',
        sessionId: review.id,
        sessionVersion: review.version - 1,
        decision: 'approve',
        adaptationId,
      }),
    ).toMatchObject({ code: 'STALE_VERSION' });
    expect(
      await send(scope, {
        type: 'studioReview',
        sessionId: review.id,
        sessionVersion: review.version,
        decision: 'approve',
        adaptationId,
      }),
    ).toMatchObject({ code: 'APPLIED', updateType: 'studio.adaptation_pending' });
    const pending = await session(scope);
    expect(pending.phase).toBe('PENDING_HATCH');
    // The open ordinary ballot for the same slot became the hatch boundary; nothing changed yet.
    const hatchRound = await openRound(scope);
    expect(hatchRound?.checkpoint.studioHatch?.adaptationId).toBe(adaptationId);
    expect(hatchRound?.checkpoint.clock.paused).toBe(false);
    const waiting = await organism(scope);
    expect(waiting).toMatchObject({
      pulse: before.pulse,
      grit: before.grit,
      design_version: 0,
      appearance_hash: null,
    });
    expect(waiting.mutation_slots.reservation).toEqual({
      adaptationId,
      slot: before.mutation_slots.next,
    });
    const snapshot = (await readSnapshot(pool, scope.worldId, scope.channelId))!.payload;
    expect(snapshot.studio.session?.pending?.message).toBe(
      'Community design selected. Hatches after the current round.',
    );
    expect(snapshot.organism?.appearance.kind).toBe('founder');

    await advance(scope, 3_200);
    const hatched = await organism(scope);
    const expected = applyMove(
      { pulse: before.pulse, calm: before.calm, grit: before.grit, drift: before.drift },
      studioMutationMove(first!)!,
      candidateRuleset.genome,
    )!;
    expect(hatched).toMatchObject({
      ...expected,
      design_version: 1,
      appearance: { kind: 'studio' },
    });
    expect(hatched.appearance_hash).toBe(voting.shortlist!.finalists[anaIndex - 1]!.hash);
    expect(
      hatched.mutation_slots.commitments.filter((item) => item.operationId === adaptationId),
    ).toHaveLength(1);
    expect(hatched.mutation_slots.reservation).toBeNull();
    expect((await session(scope)).phase).toBe('COMPLETED');
    // A repeated settle or stale deadline never applies the genes again.
    await settleSyntheticWorld(pool, scope);
    expect(await organism(scope)).toMatchObject({ grit: hatched.grit, design_version: 1 });
    const transitions = (
      await pool.query<{ to_phase: string }>(
        'select to_phase from studio_transitions where world_id=$1 and session_id=$2 order by version',
        [scope.worldId, review.id],
      )
    ).rows.map((row) => row.to_phase);
    expect(transitions).toEqual([
      'OPENING',
      'CREATING',
      'VOTING',
      'REVIEW',
      'PENDING_HATCH',
      'COMPLETED',
    ]);
  });

  it('resolves to Keep current with no proposals or no votes and changes nothing', async () => {
    const scope = await world();
    const before = await organism(scope);
    await send(scope, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    await advance(scope, 10_000);
    expect(await session(scope)).toMatchObject({
      phase: 'COMPLETED',
      selection: { kind: 'keep_current' },
    });
    expect((await openRound(scope))?.checkpoint.clock.paused).toBe(false);
    await send(scope, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    const second = await session(scope);
    await send(scope, propose(second.challenge, 'ana'));
    await advance(scope, 10_000);
    await advance(scope, 10_000);
    expect(await session(scope)).toMatchObject({
      phase: 'COMPLETED',
      selection: { kind: 'keep_current' },
    });
    expect(await organism(scope)).toMatchObject({
      grit: before.grit,
      design_version: 0,
      appearance_hash: null,
    });
  });

  it('cancels creation on return without applying drafts and adds no change across repeated toggles', async () => {
    const scope = await world();
    const before = await organism(scope);
    for (let toggle = 0; toggle < 5; toggle++) {
      await send(scope, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
      const opened = await session(scope);
      await send(scope, propose(opened.challenge, `artist-${toggle}`));
      expect(await send(scope, { type: 'studioReturn', trigger: 'manual' })).toMatchObject({
        updateType: 'studio.cancelled',
      });
      expect((await session(scope)).outcome).toEqual({ reason: 'host_returned' });
    }
    const after = await organism(scope);
    expect(after).toMatchObject({
      pulse: before.pulse,
      calm: before.calm,
      grit: before.grit,
      drift: before.drift,
      design_version: 0,
    });
    expect(after.mutation_slots).toEqual(before.mutation_slots);
    expect((await openRound(scope))?.checkpoint.clock.paused).toBe(false);
  });

  it('follows the return-during-voting policy and keeps an accepted review through offline status', async () => {
    const cancel = await world({ returnDuringVoting: 'cancel' });
    await send(cancel, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    await send(cancel, propose((await session(cancel)).challenge, 'ana'));
    await advance(cancel, 10_000);
    expect((await session(cancel)).phase).toBe('VOTING');
    await send(cancel, { type: 'studioReturn', trigger: 'manual' });
    expect(await session(cancel)).toMatchObject({
      phase: 'CANCELLED',
      outcome: { reason: 'host_returned_during_voting' },
    });
    expect((await openRound(cancel))?.checkpoint.clock.paused).toBe(false);

    const finish = await world();
    await send(finish, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    await send(finish, propose((await session(finish)).challenge, 'ana'));
    await advance(finish, 10_000);
    await send(finish, { type: 'studioReturn', trigger: 'manual' });
    expect((await session(finish)).phase).toBe('VOTING');
    await send(finish, { type: 'vote', actorKey: 'v', choice: 1 });
    await advance(finish, 10_000);
    expect((await session(finish)).phase).toBe('REVIEW');
    await send(finish, { type: 'stream', online: false });
    expect((await session(finish)).phase).toBe('REVIEW');
    await send(finish, { type: 'stream', online: true });
    await advance(finish, 60_000);
    expect(await session(finish)).toMatchObject({
      phase: 'EXPIRED',
      outcome: { reason: 'review_expired' },
    });
    expect(await organism(finish)).toMatchObject({ design_version: 0, appearance_hash: null });

    const offline = await world();
    await send(offline, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    await send(offline, propose((await session(offline)).challenge, 'ana'));
    await advance(offline, 10_000);
    await send(offline, { type: 'vote', actorKey: 'v', choice: 1 });
    await send(offline, { type: 'stream', online: false });
    expect(await session(offline)).toMatchObject({
      phase: 'CANCELLED',
      outcome: { reason: 'stream_offline' },
    });
  });

  it('maps only configured OBS scenes on enabled channels and never infers a return from a stale bridge', async () => {
    const scope = await world();
    expect(
      await send(scope, { type: 'bridgeScene', scene: 'Gameplay', sessionId: randomUUID() }),
    ).toMatchObject({
      code: 'NO_CHANGE',
    });
    expect(
      await send(scope, { type: 'bridgeScene', scene: 'Be right back', sessionId: randomUUID() }),
    ).toMatchObject({
      updateType: 'studio.opened',
    });
    expect(await send(scope, { type: 'bridgeStale' })).toMatchObject({
      updateType: 'availability.changed',
    });
    expect((await session(scope)).phase).toBe('CREATING');
    const view = (await readSnapshot(pool, scope.worldId, scope.channelId))!.payload.studio;
    expect(view.availability).toEqual({ state: 'REST', source: 'bridge', bridgeStale: true });
    // Reconciling the same break scene on reconnect opens nothing new.
    expect(
      await send(scope, { type: 'bridgeScene', scene: 'Be right back', sessionId: randomUUID() }),
    ).toMatchObject({
      updateType: 'availability.changed',
    });
    expect(
      await send(scope, { type: 'bridgeScene', scene: 'Main', sessionId: randomUUID() }),
    ).toMatchObject({
      updateType: 'studio.cancelled',
    });
    await send(scope, { type: 'inputHealth', healthy: false });
    expect(
      await send(scope, { type: 'bridgeScene', scene: 'Be right back', sessionId: randomUUID() }),
    ).toMatchObject({
      code: 'STUDIO_UNAVAILABLE',
    });
    const disabled = await world({ enabled: false });
    expect(
      await send(disabled, {
        type: 'bridgeScene',
        scene: 'Be right back',
        sessionId: randomUUID(),
      }),
    ).toMatchObject({
      code: 'STUDIO_DISABLED',
    });
  });

  it('reserves the next slot when a break interrupts observation and hatches only after that observation', async () => {
    const scope = await world();
    await advance(scope, 3_200);
    expect((await openRound(scope))?.checkpoint.clock.phase).toBe('OBSERVING');
    const consumed = await organism(scope);
    await send(scope, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    const opened = await session(scope);
    expect(opened.challenge.targetMutationSlot).toBe(consumed.mutation_slots.next);
    await send(scope, propose(opened.challenge, 'ana'));
    await advance(scope, 10_000);
    await send(scope, { type: 'vote', actorKey: 'v', choice: 1 });
    await advance(scope, 10_000);
    const review = await session(scope);
    expect(
      await send(scope, {
        type: 'studioReview',
        sessionId: review.id,
        sessionVersion: review.version,
        decision: 'approve',
        adaptationId: randomUUID(),
      }),
    ).toMatchObject({ code: 'APPLIED' });
    // Opening another studio cannot skip the outstanding observation or add a second design.
    expect(
      await send(scope, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() }),
    ).toMatchObject({
      detail: { reason: 'studio_active' },
    });
    for (const actorKey of ['a', 'b', 'c']) await send(scope, { type: 'activity', actorKey });
    await advance(scope, 12_000);
    await advance(scope, 800);
    const hatchRound = await openRound(scope);
    expect(hatchRound?.checkpoint.studioHatch).toBeDefined();
    expect(hatchRound?.checkpoint.candidates).toEqual([]);
    await advance(scope, 3_200);
    expect(await organism(scope)).toMatchObject({ design_version: 1 });
    expect((await session(scope)).phase).toBe('COMPLETED');
  });

  it('recovers phase and deadlines from PostgreSQL after a restart', async () => {
    const scope = await world();
    await send(scope, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    const restarted = new pg.Pool({ connectionString: temporary.connectionString });
    try {
      await advanceSyntheticClock(restarted, scope, scope.ownerCapability, randomUUID(), 10_000);
      expect((await session(scope)).phase).toBe('COMPLETED');
    } finally {
      await restarted.end();
    }
  });
});
