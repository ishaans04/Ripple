import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  MAX_BLUEPRINT_BYTES,
  proposalSubmissionSchema,
  studioReviewSchema,
  studioSettingsSchema,
  type GameCommand,
} from '@ripple/contracts';
import { acceptInputInTransaction, IntakeError, transaction } from '@ripple/database';
import { sha256Hex } from '@ripple/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { queueOwnerCommand } from './controller.ts';
import { equalSecret, opaqueToken, privateHash, type TwitchConfig } from './security.ts';
import {
  ControlError,
  cookie,
  ownerSession,
  requireOrigin,
  setCookie,
  type OwnerSession,
} from './sessions.ts';

const version = z.strictObject({ expectedVersion: z.int().nonnegative() });
const settingsBody = version.extend({ settings: studioSettingsSchema });
const reviewBody = studioReviewSchema.extend({ expectedVersion: z.int().nonnegative() });
const releaseBody = z.strictObject({
  expectedVersion: z.int().nonnegative(),
  sessionVersion: z.int().nonnegative(),
});
const blockBody = version.extend({
  artistKey: z.string().regex(/^[a-f0-9]{64}$/),
  blocked: z.boolean(),
});
const idParam = z.strictObject({ id: z.uuid().transform((id) => id.toLowerCase()) });
const proposalParams = idParam.extend({ proposalId: z.uuid().transform((id) => id.toLowerCase()) });

export interface ArtistSession {
  world_id: string;
  artist_key: string;
  login: string;
  csrf_hash: string;
}
const ARTIST_COOKIE = '__Host-ripple-artist';
const ARTIST_CSRF = '__Host-ripple-artist-csrf';

/** Artist identity is purpose-bound: it can submit and withdraw its own proposals only. */
export async function artistSession(
  pool: pg.Pool,
  request: FastifyRequest,
  config: TwitchConfig,
  write = false,
): Promise<ArtistSession> {
  const raw = cookie(request, ARTIST_COOKIE);
  if (raw === undefined) throw new ControlError(401, 'ARTIST_SIGN_IN_REQUIRED');
  const row = (
    await pool.query<ArtistSession>(
      'select world_id,artist_key,login,csrf_hash from artist_sessions where hash=$1 and expires_at>clock_timestamp()',
      [privateHash(config.sessionSecret, 'artist-session', raw)],
    )
  ).rows[0];
  if (row === undefined) throw new ControlError(401, 'ARTIST_SIGN_IN_REQUIRED');
  if (write) {
    requireOrigin(request, config.origin);
    const csrf = request.headers['x-csrf-token'];
    if (
      typeof csrf !== 'string' ||
      !equalSecret(privateHash(config.sessionSecret, 'artist-csrf', csrf), row.csrf_hash)
    )
      throw new ControlError(403, 'CSRF_FAILED');
  }
  return row;
}
export async function createArtistSession(
  pool: pg.Pool,
  reply: FastifyReply,
  worldId: string,
  subject: string,
  login: string,
  secret: string,
): Promise<void> {
  const session = opaqueToken(),
    csrf = opaqueToken();
  await pool.query(
    "insert into artist_sessions(hash,world_id,artist_key,login,csrf_hash,expires_at) values($1,$2,$3,$4,$5,clock_timestamp()+interval '12 hours')",
    [
      privateHash(secret, 'artist-session', session),
      worldId,
      // The Twitch account ID never leaves the server; proposals carry only this keyed hash.
      privateHash(secret, 'artist', worldId, subject),
      login.slice(0, 40),
      privateHash(secret, 'artist-csrf', csrf),
    ],
  );
  setCookie(reply, ARTIST_COOKIE, session, 43200);
  setCookie(reply, ARTIST_CSRF, csrf, 43200, false);
}

async function studioOwner(pool: pg.Pool, owner: OwnerSession, sessionId: string): Promise<void> {
  const owned = await pool.query(
    'select 1 from studio_sessions where world_id=$1 and channel_id=$2 and id=$3',
    [owner.world_id, owner.channel_id, sessionId],
  );
  if (owned.rowCount !== 1) throw new ControlError(404, 'STUDIO_NOT_FOUND');
}
function idempotencyKey(request: FastifyRequest): string {
  const key = z.uuid().safeParse(request.headers['idempotency-key']);
  if (!key.success) throw new ControlError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  return key.data;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ControlError(400, 'BAD_REQUEST');
  return parsed.data;
}

export function registerStudioControl(
  app: FastifyInstance,
  pool: pg.Pool,
  config: TwitchConfig,
): void {
  const limited = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  // The installation flag closes every way into a new studio; existing records stay readable.
  const requireStudio = () => {
    if (config.studio === false) throw new ControlError(409, 'STUDIO_DISABLED');
  };
  async function ownerChannel(request: FastifyRequest): Promise<OwnerSession> {
    const owner = await ownerSession(pool, request, config, true);
    const params = parse(idParam, request.params);
    if (params.id !== owner.channel_id) throw new ControlError(403, 'NOT_OWNER');
    return owner;
  }
  const ownerRoute = (
    path: string,
    action: string,
    schema: z.ZodType<{ expectedVersion: number }>,
    command: (body: never, request: FastifyRequest, owner: OwnerSession) => GameCommand,
    studioScoped = false,
  ) =>
    app.post(path, limited, async (request, reply) => {
      const owner = studioScoped
        ? await ownerSession(pool, request, config, true)
        : await ownerChannel(request);
      if (studioScoped) await studioOwner(pool, owner, parse(idParam, request.params).id);
      const key = idempotencyKey(request);
      if (action === 'studio.start') requireStudio();
      const body = parse(schema, request.body);
      if (
        action === 'studio.settings' &&
        settingsBody.safeParse(body).data?.settings.enabled === true
      )
        requireStudio();
      const receipt = await queueOwnerCommand(pool, owner, key, action, body, () =>
        Promise.resolve(command(body as never, request, owner)),
      );
      return reply.code(202).send({ operationId: key, ...receipt });
    });

  ownerRoute(
    '/api/channels/:id/studio/settings',
    'studio.settings',
    settingsBody,
    (body: z.infer<typeof settingsBody>) => ({
      type: 'studioSettings',
      settings: body.settings,
      expectedVersion: body.expectedVersion,
    }),
  );
  ownerRoute(
    '/api/channels/:id/studio/start',
    'studio.start',
    version,
    (body: z.infer<typeof version>) => ({
      type: 'studioStart',
      trigger: 'manual',
      sessionId: randomUUID(),
      expectedVersion: body.expectedVersion,
    }),
  );
  ownerRoute(
    '/api/channels/:id/studio/stop',
    'studio.stop',
    version,
    (body: z.infer<typeof version>) => ({
      type: 'studioReturn',
      trigger: 'manual',
      expectedVersion: body.expectedVersion,
    }),
  );
  ownerRoute(
    '/api/channels/:id/studio/blocks',
    'studio.block',
    blockBody,
    (body: z.infer<typeof blockBody>) => ({
      type: 'studioBlockArtist',
      artistKey: body.artistKey,
      blocked: body.blocked,
      expectedVersion: body.expectedVersion,
    }),
  );
  ownerRoute(
    '/api/studios/:id/review',
    'studio.review',
    reviewBody,
    (body: z.infer<typeof reviewBody>, request) => ({
      type: 'studioReview',
      sessionId: parse(idParam, request.params).id,
      sessionVersion: body.sessionVersion,
      decision: body.decision,
      adaptationId: randomUUID(),
      expectedVersion: body.expectedVersion,
    }),
    true,
  );
  ownerRoute(
    '/api/studios/:id/release',
    'studio.release',
    releaseBody,
    (body: z.infer<typeof releaseBody>, request) => ({
      type: 'studioRelease',
      sessionId: parse(idParam, request.params).id,
      sessionVersion: body.sessionVersion,
      expectedVersion: body.expectedVersion,
    }),
    true,
  );
  app.post('/api/studios/:id/proposals/:proposalId/remove', limited, async (request, reply) => {
    const owner = await ownerSession(pool, request, config, true);
    const params = parse(proposalParams, request.params);
    await studioOwner(pool, owner, params.id);
    const key = idempotencyKey(request);
    const body = parse(version, request.body);
    const receipt = await queueOwnerCommand(
      pool,
      owner,
      key,
      'studio.remove',
      { ...body, ...params },
      () =>
        Promise.resolve<GameCommand>({
          type: 'studioRemoveProposal',
          sessionId: params.id,
          proposalId: params.proposalId,
          expectedVersion: body.expectedVersion,
        }),
    );
    return reply.code(202).send({ operationId: key, ...receipt });
  });

  /** Issuing a bridge capability revokes the previous one; it is shown once. */
  app.post(
    '/api/channels/:id/studio/bridge-capability',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request) => {
      const owner = await ownerChannel(request);
      requireStudio();
      const capability = opaqueToken();
      await transaction(pool, async (client) => {
        await client.query('select id from channels where world_id=$1 and id=$2 for update', [
          owner.world_id,
          owner.channel_id,
        ]);
        await client.query(
          'update studio_bridge_capabilities set revoked_at=clock_timestamp() where world_id=$1 and channel_id=$2 and revoked_at is null',
          [owner.world_id, owner.channel_id],
        );
        await client.query(
          'insert into studio_bridge_capabilities(hash,world_id,channel_id) values($1,$2,$3)',
          [sha256Hex(capability), owner.world_id, owner.channel_id],
        );
      });
      return { worldId: owner.world_id, channelId: owner.channel_id, capability };
    },
  );

  /** The broadcaster's moderation view: every proposal in the current studio and bridge health. */
  app.get(
    '/api/controller/studio',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const owner = await ownerSession(pool, request, config);
      const studio = (
        await pool.query<{
          settings: unknown;
          bridge_seen_at: Date | null;
          bridge_scene: string | null;
          bridge_stale: boolean;
          bridge_issued: boolean;
        }>(
          `select cs.settings,cs.bridge_seen_at,cs.bridge_scene,cs.bridge_stale,
        exists(select 1 from studio_bridge_capabilities b where b.world_id=cs.world_id and b.channel_id=cs.channel_id and b.revoked_at is null) as bridge_issued
        from channel_studio cs where cs.world_id=$1 and cs.channel_id=$2`,
          [owner.world_id, owner.channel_id],
        )
      ).rows[0];
      const proposals = (
        await pool.query<{
          id: string;
          artist_key: string;
          credit: string;
          credit_opt_in: boolean;
          status: string;
          hash: string;
          blueprint: unknown;
          revision: number;
        }>(
          `select p.id,p.artist_key,p.credit,p.credit_opt_in,p.status,p.blueprint_hash as hash,b.blueprint,p.revision from studio_proposals p
        join studio_sessions s on s.world_id=p.world_id and s.id=p.session_id
        join appearance_blueprints b on b.world_id=p.world_id and b.hash=p.blueprint_hash
        where s.world_id=$1 and s.channel_id=$2 and s.ended_at is null and p.status='active' order by p.submitted_sequence limit 200`,
          [owner.world_id, owner.channel_id],
        )
      ).rows;
      const blocks = (
        await pool.query<{ artist_key: string }>(
          'select artist_key from studio_artist_blocks where world_id=$1 and channel_id=$2 order by created_at desc limit 50',
          [owner.world_id, owner.channel_id],
        )
      ).rows.map((row) => row.artist_key);
      return {
        settings: studio?.settings ?? null,
        bridge: {
          issued: studio?.bridge_issued ?? false,
          lastSeenAt: studio?.bridge_seen_at?.toISOString() ?? null,
          scene: studio?.bridge_scene ?? null,
          stale:
            studio?.bridge_stale === true ||
            (studio?.bridge_seen_at !== null &&
              studio?.bridge_seen_at !== undefined &&
              Date.now() - studio.bridge_seen_at.getTime() > 90_000),
        },
        proposals: proposals.map((p) => ({
          id: p.id,
          artistKey: p.artist_key,
          credit: p.credit,
          creditOptIn: p.credit_opt_in,
          hash: p.hash,
          revision: p.revision,
          blueprint: p.blueprint,
        })),
        blocks,
      };
    },
  );

  app.get(
    '/api/artist/status',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const query = z
        .strictObject({
          studio: z.uuid().transform((id) => id.toLowerCase()),
          operation: z.uuid().optional(),
        })
        .safeParse(request.query);
      if (!query.success) throw new ControlError(400, 'BAD_REQUEST');
      let artist: ArtistSession;
      try {
        artist = await artistSession(pool, request, config);
      } catch (error) {
        if (error instanceof ControlError && error.code === 'ARTIST_SIGN_IN_REQUIRED')
          return {
            signedIn: false,
            available: true,
            login: null,
            csrfToken: null,
            proposals: [],
            lastResult: null,
          };
        throw error;
      }
      const proposals = (
        await pool.query<{
          id: string;
          status: string;
          revision: number;
          blueprint_hash: string;
          credit_opt_in: boolean;
          submitted_at: Date;
        }>(
          `select p.id,p.status,p.revision,p.blueprint_hash,p.credit_opt_in,p.submitted_at from studio_proposals p
        where p.world_id=$1 and p.session_id=$2 and p.artist_key=$3 order by p.submitted_sequence desc limit 20`,
          [artist.world_id, query.data.studio, artist.artist_key],
        )
      ).rows;
      const result =
        query.data.operation === undefined
          ? undefined
          : (
              await pool.query<{ result: { code: string; detail: unknown } | null }>(
                `select e.result from inbox i left join game_events e on e.world_id=i.world_id and e.channel_id=i.channel_id and e.sequence=i.sequence
              where i.world_id=$1 and i.provider='artist' and i.message_id=$2`,
                [artist.world_id, `${artist.artist_key}:${query.data.operation}`],
              )
            ).rows[0];
      return {
        signedIn: true,
        available: true,
        login: artist.login,
        csrfToken: cookie(request, ARTIST_CSRF) ?? null,
        proposals: proposals.map((p) => ({
          id: p.id,
          status: p.status,
          revision: p.revision,
          hash: p.blueprint_hash,
          creditOptIn: p.credit_opt_in,
          submittedAtMs: p.submitted_at.getTime(),
        })),
        lastResult:
          result?.result === null || result === undefined || query.data.operation === undefined
            ? null
            : {
                operationId: query.data.operation,
                code: result.result.code,
                detail: result.result.detail,
              },
      };
    },
  );

  async function queueArtistCommand(
    artist: ArtistSession,
    sessionId: string,
    key: string,
    command: (channelId: string) => GameCommand,
    requireCreating: boolean,
  ): Promise<{ sequence: number; duplicate: boolean }> {
    return transaction(pool, async (client) => {
      const session = (
        await client.query<{ channel_id: string; phase: string }>(
          'select channel_id,phase from studio_sessions where world_id=$1 and id=$2',
          [artist.world_id, sessionId],
        )
      ).rows[0];
      if (session === undefined) throw new ControlError(404, 'STUDIO_NOT_FOUND');
      if (requireCreating && session.phase !== 'CREATING')
        throw new ControlError(409, 'STUDIO_WRONG_PHASE');
      try {
        const accepted = await acceptInputInTransaction(client, {
          worldId: artist.world_id,
          channelId: session.channel_id,
          provider: 'artist',
          messageId: `${artist.artist_key}:${key}`,
          command: command(session.channel_id),
          requiredMode: 'live',
        });
        return { sequence: accepted.sequence, duplicate: accepted.duplicate };
      } catch (error) {
        if (error instanceof IntakeError && error.code === 'RECEIPT_CONFLICT')
          throw new ControlError(409, 'IDEMPOTENCY_CONFLICT');
        throw error;
      }
    });
  }

  /** Submits or replaces the artist's own proposal; the worker validates it in channel order. */
  app.post(
    '/api/studios/:id/proposals',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const artist = await artistSession(pool, request, config, true);
      requireStudio();
      const params = parse(idParam, request.params);
      const key = idempotencyKey(request);
      if (
        new TextEncoder().encode(JSON.stringify(request.body ?? null)).length >
        MAX_BLUEPRINT_BYTES + 512
      )
        throw new ControlError(413, 'PROPOSAL_TOO_LARGE');
      const body = parse(proposalSubmissionSchema, request.body);
      if (
        body.blueprint.studioSessionId !== params.id ||
        body.blueprint.worldId !== artist.world_id
      )
        throw new ControlError(409, 'BASE_STATE_CHANGED');
      const receipt = await queueArtistCommand(
        artist,
        params.id,
        key,
        () => ({
          type: 'studioProposal',
          sessionId: params.id,
          proposalId: body.proposalId,
          artistKey: artist.artist_key,
          credit: artist.login,
          creditOptIn: body.creditOptIn,
          ...(body.inputMode === undefined ? {} : { inputMode: body.inputMode }),
          blueprint: body.blueprint,
        }),
        true,
      );
      return reply.code(202).send({ operationId: key, ...receipt });
    },
  );
  app.delete(
    '/api/studios/:id/proposals/:proposalId',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const artist = await artistSession(pool, request, config, true);
      const params = parse(proposalParams, request.params);
      const key = idempotencyKey(request);
      const receipt = await queueArtistCommand(
        artist,
        params.id,
        key,
        () => ({
          type: 'studioWithdraw',
          sessionId: params.id,
          proposalId: params.proposalId,
          artistKey: artist.artist_key,
        }),
        true,
      );
      return reply.code(202).send({ operationId: key, ...receipt });
    },
  );
  app.post('/auth/artist/logout', async (request, reply) => {
    requireOrigin(request, config.origin);
    const raw = cookie(request, ARTIST_COOKIE);
    if (raw !== undefined)
      await pool.query('delete from artist_sessions where hash=$1', [
        privateHash(config.sessionSecret, 'artist-session', raw),
      ]);
    setCookie(reply, ARTIST_COOKIE, '', 0);
    setCookie(reply, ARTIST_CSRF, '', 0, false);
    return reply.code(204).send();
  });
}
