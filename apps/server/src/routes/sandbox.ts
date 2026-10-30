import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { blueprintSchema, defaultStudioSettings, type GameCommand } from '@ripple/contracts';
import { canonicalJson, sha256Hex } from '@ripple/engine';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import {
  SandboxError,
  acceptSyntheticCommand,
  authorizeSynthetic,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
  type WorldScope,
} from '../game/sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from '../game/synthetic-clock.ts';
import { createSyntheticPeer } from '../game/synthetic-peer.ts';
import { exportAcceptedWorld } from '../game/world-replay.ts';
import { runReplay } from '../game/replay-report.ts';
import { transaction } from '@ripple/database';

/** Concurrent judge worlds; each expires after a day and can be reset at any time. */
export const MAX_SANDBOX_WORLDS = 200;
const channel = z.uuid().transform((id) => id.toLowerCase());
const actionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('vote'),
    channelId: channel,
    choice: z.int().min(1).max(3),
    crowd: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('chat'),
    channelId: channel,
    accounts: z.int().min(1).max(5),
  }),
  z.strictObject({ action: z.literal('next'), channelId: channel }),
  z.strictObject({ action: z.literal('shock'), channelId: channel }),
  z.strictObject({ action: z.literal('prepare'), channelId: channel }),
  z.strictObject({ action: z.literal('raid'), channelId: channel, destinationId: channel }),
  z.strictObject({ action: z.literal('pause'), channelId: channel }),
  z.strictObject({ action: z.literal('resume'), channelId: channel }),
  z.strictObject({ action: z.literal('studioStart'), channelId: channel }),
  z.strictObject({ action: z.literal('studioStop'), channelId: channel }),
  z.strictObject({
    action: z.literal('propose'),
    channelId: channel,
    blueprint: blueprintSchema,
    creditOptIn: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('review'),
    channelId: channel,
    decision: z.enum(['approve', 'keep']),
  }),
]);
export type SandboxAction = z.infer<typeof actionSchema>;

function capability(request: FastifyRequest): string {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
  if (token === undefined)
    throw new ApiError('UNAUTHORIZED', 401, 'A sandbox capability is required.');
  return token;
}
function sandboxFailure(error: unknown): never {
  if (error instanceof SandboxError)
    throw new ApiError(
      error.code,
      error.code === 'UNAUTHORIZED' ? 401 : error.code === 'WORLD_EXPIRED' ? 410 : 409,
      error.code === 'WORLD_EXPIRED'
        ? 'This sandbox expired. Start a new one.'
        : 'Sandbox access refused.',
    );
  throw error;
}
async function authorize(pool: pg.Pool, scope: WorldScope, owner: string): Promise<void> {
  await transaction(pool, async (client) => {
    await authorizeSynthetic(client, scope, owner);
  }).catch(sandboxFailure);
}
async function channelsOf(pool: pg.Pool, worldId: string): Promise<string[]> {
  return (
    await pool.query<{ id: string }>(
      'select id from channels where world_id=$1 order by created_at,id',
      [worldId],
    )
  ).rows.map((row) => row.id);
}

/** A labelled synthetic world with a resident, a seeded neighbor and an enabled studio. */
export async function createJudgeWorld(
  pool: pg.Pool,
): Promise<SyntheticWorld & { neighborId: string }> {
  const active =
    (
      await pool.query<{ count: number }>(
        "select count(*)::int as count from worlds where mode='sandbox' and expires_at>clock_timestamp()",
      )
    ).rows[0]?.count ?? 0;
  if (active >= MAX_SANDBOX_WORLDS)
    throw new ApiError('CAPACITY_FULL', 429, 'All sandbox slots are in use. Try again later.');
  const world = await createSyntheticWorld(pool, { mechanicsVersion: 1 });
  const neighbor = await createSyntheticPeer(
    pool,
    world,
    world.ownerCapability,
    randomUUID(),
    'Synthetic neighbor',
  );
  const settings = {
    ...defaultStudioSettings,
    enabled: true,
    creationMs: 20_000,
    votingMs: 10_000,
    reviewMs: 120_000,
    replaceCooldownMs: 5_000,
  };
  for (const id of [world.channelId, neighbor.channelId]) {
    const scope = { ...world, channelId: id };
    await acceptSyntheticCommand(
      pool,
      scope,
      world.ownerCapability,
      randomUUID(),
      syntheticSeedCommand(),
    );
    await acceptSyntheticCommand(pool, scope, world.ownerCapability, randomUUID(), {
      type: 'policy',
      visitorPolicy: 'accept',
      expectedVersion: 1,
    });
    await acceptSyntheticCommand(pool, scope, world.ownerCapability, randomUUID(), {
      type: 'studioSettings',
      settings,
    });
  }
  await settleSyntheticWorld(pool, world);
  return { ...world, neighborId: neighbor.channelId };
}

async function commandFor(
  pool: pg.Pool,
  scope: WorldScope,
  action: SandboxAction,
): Promise<GameCommand[]> {
  const actor = (name: string) =>
    sha256Hex(canonicalJson({ worldId: scope.worldId, syntheticActor: name }));
  const session = async () =>
    (
      await pool.query<{ id: string; version: number }>(
        `select id,version from studio_sessions where world_id=$1 and channel_id=$2
        and phase in ('OPENING','CREATING','VOTING','REVIEW','PENDING_HATCH')`,
        [scope.worldId, scope.channelId],
      )
    ).rows[0];
  switch (action.action) {
    case 'vote':
      // The judge votes once; a crowd adds three more synthetic accounts for the same choice.
      return (action.crowd ? ['judge', 'crowd-1', 'crowd-2', 'crowd-3'] : ['judge']).map(
        (name) => ({
          type: 'vote',
          actorKey: actor(`${name}:${randomUUID()}`),
          choice: action.choice,
        }),
      );
    case 'chat':
      return Array.from({ length: action.accounts }, (_, index) => ({
        type: 'activity',
        actorKey: actor(`chatter-${index}`),
      }));
    case 'shock':
      return [{ type: 'shock', kind: 'category_change' }];
    case 'prepare':
      return [{ type: 'prepare' }];
    case 'raid':
      return [
        {
          type: 'raid',
          transferId: randomUUID(),
          childId: randomUUID(),
          residencyId: randomUUID(),
          arrivalRoundId: randomUUID(),
          destinationChannelId: action.destinationId,
          destinationTwitchId: action.destinationId,
          retainUnenrolled: true,
        },
      ];
    case 'pause':
      return [{ type: 'pause', reason: 'manual' }];
    case 'resume':
      return [{ type: 'resume' }];
    case 'studioStart':
      return [{ type: 'studioStart', trigger: 'manual', sessionId: randomUUID() }];
    case 'studioStop':
      return [{ type: 'studioReturn', trigger: 'manual' }];
    case 'propose': {
      const open = await session();
      if (open === undefined) throw new ApiError('STUDIO_WRONG_PHASE', 409, 'No studio is open.');
      return [
        {
          type: 'studioProposal',
          sessionId: open.id,
          proposalId: randomUUID(),
          artistKey: actor('judge-artist'),
          credit: 'synthetic-judge',
          creditOptIn: action.creditOptIn,
          blueprint: action.blueprint,
        },
      ];
    }
    case 'review': {
      const open = await session();
      if (open === undefined)
        throw new ApiError('STUDIO_WRONG_PHASE', 409, 'No studio awaits review.');
      return [
        {
          type: 'studioReview',
          sessionId: open.id,
          sessionVersion: open.version,
          decision: action.decision,
          adaptationId: randomUUID(),
        },
      ];
    }
    case 'next':
      return [];
  }
}

export function registerSandboxRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post(
    '/api/sandbox',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const world = await createJudgeWorld(pool);
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        synthetic: true,
        worldId: world.worldId,
        channelId: world.channelId,
        neighborId: world.neighborId,
        capability: world.ownerCapability,
      });
    },
  );
  app.post(
    '/api/sandbox/:worldId/actions',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const owner = capability(request);
      const worldId = z
        .uuid()
        .parse((request.params as { worldId: string }).worldId)
        .toLowerCase();
      const body = actionSchema.safeParse(request.body);
      if (!body.success) throw new ApiError('BAD_REQUEST', 400, 'Unsupported sandbox action.');
      const action = body.data;
      const channels = await channelsOf(pool, worldId);
      for (const id of [
        action.channelId,
        ...(action.action === 'raid' ? [action.destinationId] : []),
      ])
        if (!channels.includes(id))
          throw new ApiError('NOT_FOUND', 404, 'Channel is not in this sandbox.');
      const scope = { worldId, channelId: action.channelId };
      await authorize(pool, scope, owner);
      const results: unknown[] = [];
      if (action.action === 'next') {
        // Advance the shared synthetic clock to this channel's next scheduled step.
        const due = (
          await pool.query<{ wait: number | null }>(
            `select greatest(1,ceil(extract(epoch from min(d.due_at-w.clock_at))*1000))::int as wait
            from deadlines d join worlds w on w.id=d.world_id where d.world_id=$1 and d.channel_id=$2 and d.status in ('pending','leased')`,
            [worldId, action.channelId],
          )
        ).rows[0]?.wait;
        if (due === null || due === undefined)
          throw new ApiError('BAD_REQUEST', 409, 'Nothing is scheduled; act first.');
        results.push(
          await advanceSyntheticClock(
            pool,
            scope,
            owner,
            randomUUID(),
            Math.min(due, 300_000),
          ).catch(sandboxFailure),
        );
      } else
        for (const command of await commandFor(pool, scope, action)) {
          const accepted = await acceptSyntheticCommand(
            pool,
            scope,
            owner,
            randomUUID(),
            command,
          ).catch(sandboxFailure);
          await settleSyntheticWorld(pool, scope);
          results.push(
            (
              await pool.query<{ result: unknown }>(
                'select result from game_events where world_id=$1 and channel_id=$2 and sequence=$3',
                [worldId, action.channelId, accepted.sequence],
              )
            ).rows[0]?.result ?? null,
          );
        }
      return { synthetic: true, action: action.action, results };
    },
  );
  app.post(
    '/api/sandbox/:worldId/reset',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const owner = capability(request);
      const worldId = z
        .uuid()
        .parse((request.params as { worldId: string }).worldId)
        .toLowerCase();
      const [first] = await channelsOf(pool, worldId);
      if (first === undefined) throw new ApiError('NOT_FOUND', 404, 'Sandbox not found.');
      await transaction(pool, async (client) => {
        await authorizeSynthetic(client, { worldId, channelId: first }, owner);
        // The old world ends immediately; nothing in it can be read or changed afterwards.
        await client.query('update worlds set expires_at=clock_timestamp() where id=$1', [worldId]);
      }).catch(sandboxFailure);
      const world = await createJudgeWorld(pool);
      return reply.code(201).send({
        synthetic: true,
        worldId: world.worldId,
        channelId: world.channelId,
        neighborId: world.neighborId,
        capability: world.ownerCapability,
      });
    },
  );
  app.post(
    '/api/sandbox/:worldId/replay',
    { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (request) => {
      const owner = capability(request);
      const worldId = z
        .uuid()
        .parse((request.params as { worldId: string }).worldId)
        .toLowerCase();
      const [first] = await channelsOf(pool, worldId);
      if (first === undefined) throw new ApiError('NOT_FOUND', 404, 'Sandbox not found.');
      await authorize(pool, { worldId, channelId: first }, owner);
      const report = await runReplay(pool, await exportAcceptedWorld(pool, worldId));
      return { synthetic: true, ...report };
    },
  );
}
