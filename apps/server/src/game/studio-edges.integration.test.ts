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
import type { MutationSlots } from '@ripple/engine';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';

/** Addendum section 22 rows not already covered by the lifecycle and mechanics journeys. */
describe('studio failure and edge-case handling', () => {
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
  async function send(scope: SyntheticWorld, value: unknown) {
    const accepted = await acceptSyntheticCommand(
      pool,
      scope,
      scope.ownerCapability,
      randomUUID(),
      value,
    );
    await settleSyntheticWorld(pool, scope);
    return (
      await pool.query<{
        result: { code: string; updateType: string | null; detail: Record<string, unknown> };
      }>('select result from game_events where world_id=$1 and channel_id=$2 and sequence=$3', [
        scope.worldId,
        scope.channelId,
        accepted.sequence,
      ])
    ).rows[0]?.result;
  }
  async function advance(scope: SyntheticWorld, ms: number) {
    await advanceSyntheticClock(pool, scope, scope.ownerCapability, randomUUID(), ms);
  }
  async function world(overrides: Partial<StudioSettings> = {}, genome?: number[]) {
    const scope = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(scope, syntheticSeedCommand());
    if (genome !== undefined)
      // Fixture shortcut to a boundary genome (sum 24) that would take many rounds to reach.
      await pool.query(
        `update organisms o set pulse=$3,calm=$4,grit=$5,drift=$6 from residencies r
        where r.world_id=o.world_id and r.organism_id=o.id and r.world_id=$1 and r.channel_id=$2 and r.role='resident'`,
        [scope.worldId, scope.channelId, ...genome],
      );
    await send(scope, {
      type: 'studioSettings',
      settings: {
        ...defaultStudioSettings,
        enabled: true,
        creationMs: 10_000,
        votingMs: 10_000,
        ...overrides,
      },
    });
    return scope;
  }
  async function session(scope: SyntheticWorld) {
    return (
      await pool.query<{
        id: string;
        phase: string;
        version: number;
        challenge: StudioChallenge;
        outcome: { reason: string } | null;
      }>(
        'select * from studio_sessions where world_id=$1 and channel_id=$2 order by created_at desc limit 1',
        [scope.worldId, scope.channelId],
      )
    ).rows[0]!;
  }
  async function resident(scope: SyntheticWorld) {
    return (
      await pool.query<{
        id: string;
        pulse: number;
        calm: number;
        grit: number;
        drift: number;
        design_version: number;
        appearance_hash: string | null;
        mutation_slots: MutationSlots;
      }>(
        `select o.* from organisms o join residencies r on r.world_id=o.world_id and r.organism_id=o.id
        where r.world_id=$1 and r.channel_id=$2 and r.role='resident' and r.ended_at is null`,
        [scope.worldId, scope.channelId],
      )
    ).rows[0]!;
  }
  function proposal(challenge: StudioChallenge, overrides: Record<string, unknown> = {}) {
    return {
      type: 'studioProposal',
      sessionId: challenge.studioSessionId,
      proposalId: randomUUID(),
      artistKey: createHash('sha256').update(randomUUID()).digest('hex'),
      credit: 'artist',
      creditOptIn: false,
      blueprint: {
        schemaVersion: 1,
        worldId: challenge.worldId,
        studioSessionId: challenge.studioSessionId,
        baseOrganismId: challenge.baseOrganismId,
        baseOrganismVersion: challenge.baseOrganismVersion,
        mutationTemplateId: challenge.mutationTemplateIds[0],
        rendererVersion: 'shell-v1',
        part: founderShell,
        ...overrides,
      },
    };
  }
  /** Opens a studio, submits one design, collects one vote and stops at review. */
  async function toReview(scope: SyntheticWorld, overrides: Record<string, unknown> = {}) {
    await send(scope, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    const opened = await session(scope);
    expect(await send(scope, proposal(opened.challenge, overrides))).toMatchObject({
      code: 'APPLIED',
    });
    await advance(scope, 10_000);
    await send(scope, { type: 'vote', actorKey: 'voter', choice: 1 });
    await advance(scope, 10_000);
    return session(scope);
  }
  const review = (
    id: string,
    version: number,
    decision: 'approve' | 'keep',
    adaptationId = randomUUID(),
  ) => ({
    type: 'studioReview',
    sessionId: id,
    sessionVersion: version,
    decision,
    adaptationId,
  });

  it('records a broadcaster rejection and leaves the game state unchanged', async () => {
    const scope = await world();
    const before = await resident(scope);
    const pending = await toReview(scope);
    expect(pending.phase).toBe('REVIEW');
    expect(await send(scope, review(pending.id, pending.version, 'keep'))).toMatchObject({
      code: 'APPLIED',
      updateType: 'studio.cancelled',
    });
    expect(await session(scope)).toMatchObject({
      phase: 'CANCELLED',
      outcome: { reason: 'broadcaster_kept_current' },
    });
    expect(await resident(scope)).toEqual(before);
  });

  it('treats a duplicate approval as harmless and releases a pending reservation explicitly', async () => {
    const scope = await world();
    // A break during observation: the reserved slot waits for a later mutation opening.
    await advance(scope, 3_200);
    const before = await resident(scope);
    const pending = await toReview(scope);
    const adaptationId = randomUUID();
    expect(
      await send(scope, review(pending.id, pending.version, 'approve', adaptationId)),
    ).toMatchObject({ code: 'APPLIED' });
    expect(
      await send(scope, review(pending.id, pending.version, 'approve', adaptationId)),
    ).toMatchObject({
      code: 'STUDIO_WRONG_PHASE',
    });
    const reserved = await session(scope);
    expect((await resident(scope)).mutation_slots.reservation?.adaptationId).toBe(adaptationId);
    // Release is refused for a stale session version, then recorded once with the reservation freed.
    expect(
      await send(scope, {
        type: 'studioRelease',
        sessionId: reserved.id,
        sessionVersion: reserved.version - 1,
      }),
    ).toMatchObject({
      code: 'STALE_VERSION',
    });
    expect(
      await send(scope, {
        type: 'studioRelease',
        sessionId: reserved.id,
        sessionVersion: reserved.version,
      }),
    ).toMatchObject({
      code: 'APPLIED',
    });
    expect(await session(scope)).toMatchObject({
      phase: 'CANCELLED',
      outcome: { reason: 'broadcaster_released' },
    });
    const after = await resident(scope);
    expect(after.mutation_slots.reservation).toBeNull();
    expect(after).toMatchObject({ grit: before.grit, design_version: 0, appearance_hash: null });
    expect(
      (
        await pool.query<{ status: string }>(
          'select status from pending_adaptations where world_id=$1 and id=$2',
          [scope.worldId, adaptationId],
        )
      ).rows[0]?.status,
    ).toBe('released');
  });

  it('holds back a design whose base changed incompatibly before its hatch instead of rebasing it', async () => {
    const scope = await world();
    const pending = await toReview(scope);
    await send(scope, review(pending.id, pending.version, 'approve'));
    // The open ordinary ballot became the hatch, so the result can no longer be released.
    const hatching = await session(scope);
    expect(
      await send(scope, {
        type: 'studioRelease',
        sessionId: hatching.id,
        sessionVersion: hatching.version,
      }),
    ).toMatchObject({ code: 'STUDIO_WRONG_PHASE', detail: { reason: 'hatch_in_progress' } });
    // Fault injection: a genetic change the game itself cannot make while the slot is reserved.
    await pool.query(
      `update organisms o set pulse=pulse-1,drift=drift+1,design_version=design_version+1 from residencies r
      where r.world_id=o.world_id and r.organism_id=o.id and r.world_id=$1 and r.channel_id=$2 and r.role='resident'`,
      [scope.worldId, scope.channelId],
    );
    const changed = await resident(scope);
    await advance(scope, 3_200);
    expect(await session(scope)).toMatchObject({
      phase: 'CANCELLED',
      outcome: { reason: 'BASE_STATE_CHANGED' },
    });
    const after = await resident(scope);
    expect(after).toMatchObject({
      pulse: changed.pulse,
      calm: changed.calm,
      grit: changed.grit,
      drift: changed.drift,
      appearance_hash: null,
    });
    expect(after.mutation_slots.reservation).toBeNull();
    // The slot was not consumed by the rejected design.
    expect(after.mutation_slots.lastMutation).toBe(changed.mutation_slots.lastMutation);
  });

  it('rejects an unsupported renderer version with an explicit compatibility error', async () => {
    const scope = await world();
    await send(scope, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    const opened = await session(scope);
    expect(
      await send(scope, proposal(opened.challenge, { rendererVersion: 'shell-v2' })),
    ).toMatchObject({
      code: 'INVALID_BLUEPRINT',
    });
    expect(
      await send(
        scope,
        proposal(opened.challenge, {
          baseOrganismVersion: opened.challenge.baseOrganismVersion + 1,
        }),
      ),
    ).toMatchObject({ code: 'BASE_STATE_CHANGED' });
  });

  it('hatches a cosmetic-only design without any gene or fitness change, or defers by policy', async () => {
    const deferred = await world({ cosmeticPolicy: 'defer' }, [3, 3, 15, 3]);
    expect(
      await send(deferred, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() }),
    ).toMatchObject({
      code: 'APPLIED',
      updateType: 'availability.changed',
      detail: { opened: false, reason: 'cosmetic_only_deferred' },
    });
    const scope = await world({ approval: 'auto' }, [3, 3, 15, 3]);
    const before = await resident(scope);
    // Automatic approval applies only after the vote and every normal check.
    const approved = await toReview(scope, { mutationTemplateId: 'cosmetic-only' });
    expect(approved.phase).toBe('PENDING_HATCH');
    expect(approved.challenge.mutationTemplateIds).toEqual(['cosmetic-only']);
    await advance(scope, 3_200);
    const after = await resident(scope);
    expect(after).toMatchObject({ pulse: 3, calm: 3, grit: 15, drift: 3 });
    expect(after.appearance_hash).not.toBeNull();
    expect(after.mutation_slots.lastMutation).toBe(before.mutation_slots.lastMutation + 1);
    expect((await session(scope)).phase).toBe('COMPLETED');
  });
});
