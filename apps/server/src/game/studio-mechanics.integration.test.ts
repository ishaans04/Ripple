import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations, transaction } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { defaultStudioSettings, founderShell, type StudioChallenge } from '@ripple/contracts';
import type { MutationSlots } from '@ripple/engine';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from './synthetic-clock.ts';
import { createSyntheticPeer } from './synthetic-peer.ts';
import { readPassport } from './passport-read.ts';
import { loadContext } from './store.ts';
import { cancelStudioForInactive } from './studio.ts';

const artist = (name: string) => createHash('sha256').update(name).digest('hex');

describe('studio designs in existing lineage mechanics', () => {
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
    await acceptSyntheticCommand(pool, scope, scope.ownerCapability, randomUUID(), value);
    await settleSyntheticWorld(pool, scope);
  }
  async function advance(scope: SyntheticWorld, ms: number) {
    await advanceSyntheticClock(pool, scope, scope.ownerCapability, randomUUID(), ms);
  }
  async function organism(scope: SyntheticWorld, id: string) {
    return (
      await pool.query<{
        status: string;
        pulse: number;
        calm: number;
        grit: number;
        drift: number;
        appearance_hash: string | null;
        appearance: { kind: string };
        mutation_slots: MutationSlots;
      }>('select * from organisms where world_id=$1 and id=$2', [scope.worldId, id])
    ).rows[0]!;
  }
  async function session(scope: SyntheticWorld) {
    return (
      await pool.query<{
        id: string;
        phase: string;
        version: number;
        organism_id: string;
        challenge: StudioChallenge;
        shortlist: { finalists: { hash: string; template: string }[] } | null;
        selection: { dormantId?: string } | null;
        outcome: { reason: string } | null;
      }>(
        'select * from studio_sessions where world_id=$1 and channel_id=$2 order by created_at desc limit 1',
        [scope.worldId, scope.channelId],
      )
    ).rows[0]!;
  }
  function design(challenge: StudioChallenge, template: string, width: number) {
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
  /** Runs a studio with two finalists in different directions to an approved, pending design. */
  async function approvedStudio(scope: SyntheticWorld, winnerVotes: number, loserVotes: number) {
    await send(scope, { type: 'studioStart', trigger: 'manual', sessionId: randomUUID() });
    const opened = await session(scope);
    const [first, second] = opened.challenge.mutationTemplateIds;
    for (const [name, template, width, optIn] of [
      ['ana', first!, 700, true],
      ['ben', second!, 400, false],
    ] as const)
      await send(scope, {
        type: 'studioProposal',
        sessionId: opened.id,
        proposalId: randomUUID(),
        artistKey: artist(name),
        credit: name,
        creditOptIn: optIn,
        blueprint: design(opened.challenge, template, width),
      });
    await advance(scope, 10_000);
    const voting = await session(scope);
    const winner = voting.shortlist!.finalists.findIndex((item) => item.template === first) + 1;
    for (let i = 0; i < winnerVotes; i++)
      await send(scope, { type: 'vote', actorKey: `w${i}`, choice: winner });
    for (let i = 0; i < loserVotes; i++)
      await send(scope, { type: 'vote', actorKey: `l${i}`, choice: 3 - winner });
    await advance(scope, 10_000);
    const review = await session(scope);
    await send(scope, {
      type: 'studioReview',
      sessionId: review.id,
      sessionVersion: review.version,
      decision: 'approve',
      adaptationId: randomUUID(),
    });
    return {
      session: await session(scope),
      winnerHash: voting.shortlist!.finalists[winner - 1]!.hash,
      loserHash: voting.shortlist!.finalists[2 - winner]!.hash,
    };
  }
  async function raid(source: SyntheticWorld, label: string) {
    const peer = await createSyntheticPeer(
      pool,
      source,
      source.ownerCapability,
      randomUUID(),
      label,
    );
    const host = { ...source, channelId: peer.channelId };
    await send(host, { type: 'policy', visitorPolicy: 'accept', expectedVersion: 0 });
    const childId = randomUUID();
    await send(source, {
      type: 'raid',
      transferId: randomUUID(),
      childId,
      residencyId: randomUUID(),
      arrivalRoundId: randomUUID(),
      destinationChannelId: host.channelId,
      destinationTwitchId: host.channelId,
    });
    return { host, childId };
  }

  it('passes only committed designs to descendants and records studio provenance and dormant art', async () => {
    const source = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(source, syntheticSeedCommand());
    await send(source, {
      type: 'studioSettings',
      settings: { ...defaultStudioSettings, enabled: true, creationMs: 10_000, votingMs: 10_000 },
    });
    const before = await raid(source, 'Before studio');
    const { session: pending, winnerHash, loserHash } = await approvedStudio(source, 3, 2);
    expect(pending.phase).toBe('PENDING_HATCH');
    // The losing finalist in a different direction is kept as a dormant capture with its art.
    const dormant = (
      await pool.query<{
        blueprint_hash: string;
        provenance: { studio: { blueprintHash: string } };
      }>(
        "select blueprint_hash,provenance from dormant_mutations where world_id=$1 and organism_id=$2 and status='active'",
        [source.worldId, pending.organism_id],
      )
    ).rows[0];
    expect(dormant?.blueprint_hash).toBe(loserHash);
    expect(dormant?.provenance.studio.blueprintHash).toBe(loserHash);
    const during = await raid(source, 'During incubation');
    expect((await organism(source, during.childId)).appearance.kind).toBe('founder');
    await advance(source, 3_200);
    const parent = await organism(source, pending.organism_id);
    expect(parent.appearance_hash).toBe(winnerHash);
    // Existing children keep the design they were born with.
    expect((await organism(source, before.childId)).appearance_hash).toBeNull();
    expect((await organism(source, during.childId)).appearance_hash).toBeNull();
    const after = await raid(source, 'After hatch');
    const child = await organism(source, after.childId);
    expect(child).toMatchObject({
      appearance_hash: winnerHash,
      pulse: parent.pulse,
      calm: parent.calm,
      grit: parent.grit,
      drift: parent.drift,
    });
    expect(child.mutation_slots.reservation).toBeNull();

    const passport = (await readPassport(pool, source, after.childId))!;
    expect(passport.design?.current).toMatchObject({
      hash: winnerHash,
      studioSessionId: pending.id,
      creatingChannel: { channelId: source.channelId },
      parentHash: null,
      artistCredit: 'ana',
      committedBy: pending.organism_id,
    });
    expect(passport.design?.history.map((item) => item.hash)).toEqual([winnerHash]);
    const parentPassport = (await readPassport(pool, source, pending.organism_id))!;
    expect(
      parentPassport.adaptations.items.some((item) => item.selection.status === 'studio'),
    ).toBe(true);

    // The descendant's shell is the visual provenance of a trace it later earns at its host.
    const host = after.host;
    for (let round = 0; round < 2; round++) {
      await advance(host, 3_200);
      for (const actorKey of ['a', 'b', 'c']) await send(host, { type: 'activity', actorKey });
      await advance(host, 12_000);
      await advance(host, 800);
    }
    const trace = (
      await pool.query<{ provenance: { emitterDesignHash?: string } }>(
        'select provenance from habitat_traces where world_id=$1 and channel_id=$2 and emitter_id=$3',
        [host.worldId, host.channelId, after.childId],
      )
    ).rows[0];
    expect(trace?.provenance.emitterDesignHash).toBe(winnerHash);
  });

  it('records no dormant design below the vote thresholds', async () => {
    const scope = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(scope, syntheticSeedCommand());
    await send(scope, {
      type: 'studioSettings',
      settings: { ...defaultStudioSettings, enabled: true, creationMs: 10_000, votingMs: 10_000 },
    });
    const { session: pending } = await approvedStudio(scope, 2, 1);
    expect(pending.phase).toBe('PENDING_HATCH');
    expect(pending.selection?.dormantId).toBeUndefined();
  });

  it('cancels a pending adaptation and releases its slot when the branch becomes a fossil', async () => {
    const scope = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
    await send(scope, syntheticSeedCommand());
    await send(scope, {
      type: 'studioSettings',
      settings: { ...defaultStudioSettings, enabled: true, creationMs: 10_000, votingMs: 10_000 },
    });
    const { session: pending } = await approvedStudio(scope, 1, 0);
    expect((await organism(scope, pending.organism_id)).mutation_slots.reservation).not.toBeNull();
    await transaction(pool, async (client) => {
      await client.query(
        "update organisms set status='FOSSIL',health=0 where world_id=$1 and id=$2",
        [scope.worldId, pending.organism_id],
      );
      const context = await loadContext(client, scope.worldId, scope.channelId);
      expect(await cancelStudioForInactive(context, 9_999, Date.now())).toBe(true);
    });
    expect(await session(scope)).toMatchObject({
      phase: 'CANCELLED',
      outcome: { reason: 'organism_fossilized' },
    });
    const fossil = await organism(scope, pending.organism_id);
    expect(fossil.mutation_slots.reservation).toBeNull();
    expect(fossil.appearance.kind).toBe('founder');
    const adaptation = (
      await pool.query<{ status: string; reason: string }>(
        'select status,reason from pending_adaptations where world_id=$1 and session_id=$2',
        [scope.worldId, pending.id],
      )
    ).rows[0];
    expect(adaptation).toEqual({ status: 'cancelled', reason: 'organism_fossilized' });
  });
});
