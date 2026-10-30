import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import { clientAnalyticsEvents } from '../game/analytics.ts';

const scopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('channel'), worldId: z.uuid(), channelId: z.uuid() }),
  z.strictObject({ kind: z.literal('studio'), sessionId: z.uuid() }),
]);
const bodySchema = z.strictObject({ event: z.enum(clientAnalyticsEvents), scope: scopeSchema });

/**
 * Anonymous product events from the browser surfaces. Only an allow-listed event name and an
 * existing scope are stored; no identity, text, video or landmark data is accepted. These are
 * advisory counts and never affect gameplay.
 */
export function registerAnalyticsRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post(
    '/api/analytics',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = bodySchema.safeParse(request.body);
      if (!body.success) throw new ApiError('BAD_REQUEST', 400, 'Unsupported analytics event.');
      const scope = body.data.scope;
      const target = (
        scope.kind === 'channel'
          ? await pool.query<{ world_id: string; channel_id: string; mode: string }>(
              `select c.world_id,c.id as channel_id,w.mode from channels c join worlds w on w.id=c.world_id
              where c.world_id=$1 and c.id=$2 and (w.expires_at is null or w.expires_at>clock_timestamp())`,
              [scope.worldId, scope.channelId],
            )
          : await pool.query<{ world_id: string; channel_id: string; mode: string }>(
              `select s.world_id,s.channel_id,w.mode from studio_sessions s join worlds w on w.id=s.world_id
              where s.id=$1 and (w.expires_at is null or w.expires_at>clock_timestamp())`,
              [scope.sessionId],
            )
      ).rows[0];
      // Unknown or replay scopes are acknowledged without storing anything.
      if (target === undefined || target.mode === 'replay') return reply.code(204).send();
      const sandbox = target.mode === 'sandbox';
      const insert = (type: string) =>
        pool.query(
          'insert into analytics_events(world_id,channel_id,id,type,aggregates) values($1,$2,$3,$4,$5)',
          [
            target.world_id,
            target.channel_id,
            randomUUID(),
            type,
            JSON.stringify({ client: true, sandbox }),
          ],
        );
      await insert(body.data.event);
      // A live channel's first overlay connection completes onboarding.
      if (body.data.event === 'overlay_seen' && !sandbox) {
        const done = await pool.query(
          "select 1 from analytics_events where world_id=$1 and channel_id=$2 and type='onboarding_completed'",
          [target.world_id, target.channel_id],
        );
        if (done.rowCount === 0) await insert('onboarding_completed');
      }
      return reply.code(204).send();
    },
  );
}
