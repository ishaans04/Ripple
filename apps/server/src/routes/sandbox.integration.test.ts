import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { channelViewSchema, founderShell, studioStateSchema } from '@ripple/contracts';
import { buildApp } from '../app.ts';

interface Judge {
  worldId: string;
  channelId: string;
  neighborId: string;
  capability: string;
}

describe('judge sandbox API', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool, app: FastifyInstance;
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    app = await buildApp({ config: { logLevel: 'silent', webRoot: undefined }, pool });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await temporary.drop();
  });
  const create = async (): Promise<Judge> => {
    const response = await app.inject({ method: 'POST', url: '/api/sandbox' });
    expect(response.statusCode).toBe(201);
    return response.json<Judge>();
  };
  const act = (judge: Judge, body: Record<string, unknown>, worldId = judge.worldId) =>
    app.inject({
      method: 'POST',
      url: `/api/sandbox/${worldId}/actions`,
      headers: { authorization: `Bearer ${judge.capability}` },
      payload: body,
    });
  const ok = async (judge: Judge, body: Record<string, unknown>) => {
    const response = await act(judge, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ results: { code: string; updateType: string | null }[] }>();
  };
  const view = async (judge: Judge, channelId = judge.channelId) =>
    channelViewSchema.parse(
      (
        await app.inject({
          url: `/api/worlds/${judge.worldId}/snapshot?channelId=${channelId}`,
          headers: { authorization: `Bearer ${judge.capability}` },
        })
      ).json<{ payload: unknown }>().payload,
    );

  it('runs the judge journey and the studio flow in an isolated synthetic world within three minutes', async () => {
    const started = Date.now();
    const judge = await create();
    const own = judge.channelId;
    let state = await view(judge);
    expect(state.mode).toBe('sandbox');
    expect(state.round?.kind).toBe('MUTATION');
    // Choose a mutation, observe the habitat and see the round result.
    await ok(judge, { action: 'vote', channelId: own, choice: 1, crowd: true });
    await ok(judge, { action: 'next', channelId: own });
    expect((await view(judge)).round?.phase).toBe('OBSERVING');
    await ok(judge, { action: 'chat', channelId: own, accounts: 3 });
    await ok(judge, { action: 'shock', channelId: own });
    await ok(judge, { action: 'next', channelId: own });
    state = await view(judge);
    expect(state.round?.analysis?.participants[0]?.ancestor).not.toBeNull();
    // A simulated raid and the neighbor's welcome.
    await ok(judge, { action: 'raid', channelId: own, destinationId: judge.neighborId });
    await ok(judge, { action: 'next', channelId: judge.neighborId });
    await ok(judge, { action: 'next', channelId: judge.neighborId });
    expect((await view(judge, judge.neighborId)).propagation?.visitor).not.toBeNull();
    // Cocoon Studio: break, a judge-built design, the vote, approval and the hatch.
    await ok(judge, { action: 'next', channelId: own });
    await ok(judge, { action: 'studioStart', channelId: own });
    state = await view(judge);
    const sessionId = state.studio?.session?.id;
    expect(state.studio?.session?.phase).toBe('CREATING');
    const studio = studioStateSchema.parse(
      (await app.inject({ url: `/api/studios/${sessionId}` })).json(),
    );
    const challenge = studio.challenge!;
    const proposed = await ok(judge, {
      action: 'propose',
      channelId: own,
      creditOptIn: true,
      blueprint: {
        schemaVersion: 1,
        worldId: challenge.worldId,
        studioSessionId: challenge.studioSessionId,
        baseOrganismId: challenge.baseOrganismId,
        baseOrganismVersion: challenge.baseOrganismVersion,
        mutationTemplateId: challenge.mutationTemplateIds[0],
        rendererVersion: 'shell-v1',
        part: { ...founderShell, parameters: { ...founderShell.parameters, width: 800 } },
      },
    });
    expect(proposed.results[0]?.code).toBe('APPLIED');
    await ok(judge, { action: 'next', channelId: own });
    await ok(judge, { action: 'vote', channelId: own, choice: 1, crowd: true });
    await ok(judge, { action: 'next', channelId: own });
    expect((await view(judge)).studio?.session?.phase).toBe('REVIEW');
    await ok(judge, { action: 'review', channelId: own, decision: 'approve' });
    for (
      let step = 0;
      step < 6 && (await view(judge)).studio?.session?.phase !== 'COMPLETED';
      step++
    )
      await ok(judge, { action: 'next', channelId: own });
    state = await view(judge);
    expect(state.studio?.session?.phase).toBe('COMPLETED');
    expect(state.organism?.appearance.kind).toBe('studio');
    // Replay reproduces every channel from accepted records alone.
    const replay = await app.inject({
      method: 'POST',
      url: `/api/sandbox/${judge.worldId}/replay`,
      headers: { authorization: `Bearer ${judge.capability}` },
    });
    expect(
      replay
        .json<{ sourceComparison: { equal: boolean }[] }>()
        .sourceComparison.every((item) => item.equal),
    ).toBe(true);
    // Reset ends the old world and starts a fresh one.
    const reset = await app.inject({
      method: 'POST',
      url: `/api/sandbox/${judge.worldId}/reset`,
      headers: { authorization: `Bearer ${judge.capability}` },
    });
    expect(reset.statusCode).toBe(201);
    const fresh = reset.json<Judge>();
    expect(fresh.worldId).not.toBe(judge.worldId);
    expect((await act(judge, { action: 'next', channelId: own })).statusCode).toBe(410);
    expect((await view(fresh)).organism?.appearance.kind).toBe('founder');
    expect(Date.now() - started).toBeLessThan(180_000);
  });

  it('keeps judges isolated from each other and from live worlds', async () => {
    const first = await create();
    const second = await create();
    expect(
      (
        await act(
          second,
          { action: 'chat', channelId: first.channelId, accounts: 1 },
          first.worldId,
        )
      ).json(),
    ).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect(
      (await act(second, { action: 'chat', channelId: first.channelId, accounts: 1 })).statusCode,
    ).toBe(404);
    const live = randomUUID();
    await pool.query(
      "insert into worlds(id,mode,rules_hash) select $1,'live',rules_hash from worlds where id=$2",
      [live, first.worldId],
    );
    await pool.query(
      "insert into channels(world_id,id,label,rules_hash,seed,configuration) select $1,$2,'Live',rules_hash,'seed',configuration from channels where world_id=$3 limit 1",
      [live, randomUUID(), first.worldId],
    );
    const liveChannel = (
      await pool.query<{ id: string }>('select id from channels where world_id=$1', [live])
    ).rows[0]!.id;
    expect(
      (await act(first, { action: 'studioStart', channelId: liveChannel }, live)).statusCode,
    ).toBe(401);
    expect(
      (
        await act(first, {
          action: 'vote',
          channelId: first.channelId,
          choice: 3,
          crowd: false,
          actor: 'x',
        })
      ).statusCode,
    ).toBe(400);
  });
});
