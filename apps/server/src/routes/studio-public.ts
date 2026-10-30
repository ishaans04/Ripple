import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  bridgeReportSchema,
  studioChallengeSchema,
  studioStateSchema,
  type GameCommand,
} from '@ripple/contracts';
import { acceptInputInTransaction, IntakeError, transaction } from '@ripple/database';
import { sha256Hex } from '@ripple/engine';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import { readSnapshot } from '../game/snapshot.ts';

const sessionParams = z.strictObject({ id: z.uuid().transform((id) => id.toLowerCase()) });

/**
 * The studio link is shared publicly in chat and on the overlay, so the unguessable session ID is
 * its read capability. It exposes the captured challenge and public studio state only.
 */
export function registerStudioPublicRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  studioEnabled = true,
): void {
  app.get(
    '/api/studios/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = sessionParams.safeParse(request.params);
      if (!params.success) throw new ApiError('BAD_REQUEST', 400, 'Specify a studio session.');
      const session = (
        await pool.query<{ world_id: string; channel_id: string; challenge: unknown }>(
          `select s.world_id,s.channel_id,s.challenge from studio_sessions s join worlds w on w.id=s.world_id
          where s.id=$1 and (w.expires_at is null or w.expires_at>clock_timestamp())`,
          [params.data.id],
        )
      ).rows[0];
      if (session === undefined)
        throw new ApiError('STUDIO_NOT_FOUND', 404, 'Studio is unavailable.');
      const snapshot = await readSnapshot(pool, session.world_id, session.channel_id);
      if (snapshot === null) throw new ApiError('STUDIO_NOT_FOUND', 404, 'Studio is unavailable.');
      const current = snapshot.payload.studio.session?.id === params.data.id;
      reply.header('cache-control', 'no-store');
      return studioStateSchema.parse({
        worldId: session.world_id,
        channelId: session.channel_id,
        label: snapshot.payload.label,
        // A later studio on the same channel is not shown through an older link.
        studio: current ? snapshot.payload.studio : { ...snapshot.payload.studio, session: null },
        challenge: current ? studioChallengeSchema.parse(session.challenge) : null,
        organism:
          snapshot.payload.organism === null
            ? null
            : {
                name: snapshot.payload.organism.name,
                genome: snapshot.payload.organism.genome,
                appearance: snapshot.payload.organism.appearance,
              },
        serverTimeMs: Date.parse(snapshot.serverTime),
      });
    },
  );
  app.get(
    '/api/blueprints/:hash',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = z
        .strictObject({ hash: z.string().regex(/^[a-f0-9]{64}$/) })
        .safeParse(request.params);
      const query = z
        .strictObject({ studio: z.uuid().transform((id) => id.toLowerCase()) })
        .safeParse(request.query);
      if (!params.success || !query.success)
        throw new ApiError('BAD_REQUEST', 400, 'Specify a design and its studio.');
      // Only finalists, approved results and committed designs are public; drafts are not.
      const row = (
        await pool.query<{
          hash: string;
          renderer_version: string;
          template: string;
          blueprint: unknown;
        }>(
          `select b.hash,b.renderer_version,b.template,b.blueprint from studio_sessions s
          join worlds w on w.id=s.world_id join appearance_blueprints b on b.world_id=s.world_id and b.hash=$2
          where s.id=$1 and (w.expires_at is null or w.expires_at>clock_timestamp()) and (
            exists(select 1 from jsonb_array_elements(coalesce(s.shortlist->'finalists','[]'::jsonb)) f where f->>'hash'=b.hash)
            or exists(select 1 from pending_adaptations p where p.world_id=s.world_id and p.session_id=s.id and p.blueprint_hash=b.hash))`,
          [query.data.studio, params.data.hash],
        )
      ).rows[0];
      if (row === undefined) throw new ApiError('NOT_FOUND', 404, 'Design is unavailable.');
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return {
        hash: row.hash,
        rendererVersion: row.renderer_version,
        template: row.template,
        blueprint: row.blueprint,
      };
    },
  );
  app.post(
    '/api/channels/:id/availability',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = sessionParams.safeParse(request.params);
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
      if (!params.success) throw new ApiError('BAD_REQUEST', 400, 'Specify a channel.');
      if (token === undefined)
        throw new ApiError('BRIDGE_UNAUTHORIZED', 401, 'A studio bridge capability is required.');
      const body = bridgeReportSchema.safeParse(request.body);
      if (!body.success) throw new ApiError('BAD_REQUEST', 400, 'Unsupported availability signal.');
      const bridge = (
        await pool.query<{
          world_id: string;
          enabled: boolean;
          stale: boolean;
          scene: string | null;
        }>(
          `select b.world_id,(cs.settings->>'enabled')::boolean as enabled,cs.bridge_stale as stale,cs.bridge_scene as scene
          from studio_bridge_capabilities b join worlds w on w.id=b.world_id
          join channel_studio cs on cs.world_id=b.world_id and cs.channel_id=b.channel_id
          where b.hash=$1 and b.channel_id=$2 and b.revoked_at is null and w.mode<>'replay'
          and (w.expires_at is null or w.expires_at>clock_timestamp())`,
          [sha256Hex(token), params.data.id],
        )
      ).rows[0];
      if (bridge === undefined)
        throw new ApiError('BRIDGE_UNAUTHORIZED', 401, 'The studio bridge capability is invalid.');
      if (!studioEnabled || !bridge.enabled)
        throw new ApiError(
          'STUDIO_DISABLED',
          409,
          'Cocoon Studio is not enabled for this channel.',
        );
      const report = body.data;
      let command: GameCommand | null = null;
      if (report.kind === 'scene')
        command = { type: 'bridgeScene', scene: report.scene, sessionId: randomUUID() };
      else if (report.kind === 'hidden') command = bridge.stale ? null : { type: 'bridgeStale' };
      // A heartbeat only records liveness; a stale bridge that is visible again reconciles its scene.
      else if (bridge.stale && report.scene !== null)
        command = { type: 'bridgeScene', scene: report.scene, sessionId: randomUUID() };
      await transaction(pool, async (client) => {
        await client.query(
          'update channel_studio set bridge_seen_at=clock_timestamp() where world_id=$1 and channel_id=$2',
          [bridge.world_id, params.data.id],
        );
        if (command !== null)
          await acceptInputInTransaction(client, {
            worldId: bridge.world_id,
            channelId: params.data.id,
            provider: 'studio-bridge',
            messageId: randomUUID(),
            command,
          }).catch((error: unknown) => {
            if (error instanceof IntakeError && error.code === 'WORLD_EXPIRED')
              throw new ApiError('WORLD_EXPIRED', 410, 'World expired.');
            throw error;
          });
      });
      return reply.code(202).send({ accepted: command !== null });
    },
  );
}
