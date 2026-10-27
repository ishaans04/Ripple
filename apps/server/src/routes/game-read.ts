import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import { authorizeRead, bearer, exchangeReadCapability } from '../game/read-access.ts';
import { snapshotEnvelope } from '../game/snapshot.ts';

const scopeSchema = z.strictObject({ worldId: z.uuid(), channelId: z.uuid() });
export function registerGameReadRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post(
    '/api/overlay/exchange',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = scopeSchema.safeParse(request.body);
      if (!parsed.success) throw new ApiError('BAD_REQUEST', 400, 'Specify a world and channel.');
      reply.header('cache-control', 'no-store');
      return exchangeReadCapability(pool, parsed.data, bearer(request.headers.authorization));
    },
  );
  app.get('/api/worlds/:id/snapshot', async (request, reply) => {
    const params = z.strictObject({ id: z.uuid() }).safeParse(request.params);
    const query = z.strictObject({ channelId: z.uuid() }).safeParse(request.query);
    if (!params.success || !query.success)
      throw new ApiError('BAD_REQUEST', 400, 'Specify a world and channel.');
    const scope = { worldId: params.data.id, channelId: query.data.channelId };
    await authorizeRead(pool, scope, bearer(request.headers.authorization));
    const snapshot = await snapshotEnvelope(pool, scope.worldId, scope.channelId);
    if (snapshot === null) throw new ApiError('NOT_FOUND', 404, 'World is unavailable.');
    reply.header('cache-control', 'no-store');
    return snapshot;
  });
}
