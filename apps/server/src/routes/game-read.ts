import { z } from 'zod';
import {
  lineageCatalogCursorSchema,
  lineageCursorSchema,
  readScopeSchema,
} from '@ripple/contracts';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ApiError } from '../errors.ts';
import { authorizeRead, bearer, exchangeReadCapability } from '../game/read-access.ts';
import { snapshotEnvelope } from '../game/snapshot.ts';
import { readRoundAnalysis } from '../game/round-analysis.ts';
import { readLineage, readLineageCatalog } from '../game/lineage-read.ts';

export function registerGameReadRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get(
    '/api/lineages',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = readScopeSchema
        .extend({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          after: lineageCatalogCursorSchema.optional(),
        })
        .safeParse(request.query);
      if (!query.success)
        throw new ApiError(
          'BAD_REQUEST',
          400,
          'Specify the channel scope and a valid lineage page cursor.',
        );
      await authorizeRead(pool, query.data, bearer(request.headers.authorization));
      const result = await readLineageCatalog(pool, query.data, query.data.limit, query.data.after);
      if (result === null) throw new ApiError('NOT_FOUND', 404, 'World is unavailable.');
      reply.header('cache-control', 'no-store');
      return result;
    },
  );
  app.get(
    '/api/lineages/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = z
          .strictObject({ id: z.uuid().transform((id) => id.toLowerCase()) })
          .safeParse(request.params),
        query = readScopeSchema
          .extend({
            limit: z.coerce.number().int().min(1).max(50).default(25),
            after: lineageCursorSchema.optional(),
          })
          .safeParse(request.query);
      if (!params.success || !query.success)
        throw new ApiError('BAD_REQUEST', 400, 'Specify a scoped lineage and valid page cursor.');
      await authorizeRead(pool, query.data, bearer(request.headers.authorization));
      const result = await readLineage(
        pool,
        query.data,
        params.data.id,
        query.data.limit,
        query.data.after,
      );
      if (result === null)
        throw new ApiError('NOT_FOUND', 404, 'Lineage is unavailable to this channel.');
      reply.header('cache-control', 'no-store');
      return result;
    },
  );
  app.get(
    '/api/rounds/:id/explanation',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = z.strictObject({ id: z.uuid() }).safeParse(request.params),
        query = readScopeSchema.safeParse(request.query);
      if (!params.success || !query.success)
        throw new ApiError('BAD_REQUEST', 400, 'Specify the round, world and channel.');
      await authorizeRead(pool, query.data, bearer(request.headers.authorization));
      const result = await readRoundAnalysis(pool, query.data, params.data.id);
      if (!result.found)
        throw new ApiError('NOT_FOUND', 404, 'Round is unavailable in this channel.');
      if (result.analysis === null)
        throw new ApiError('ROUND_UNRESOLVED', 409, 'This observation has not resolved.');
      reply.header('cache-control', 'no-store');
      return result.analysis;
    },
  );
  app.post(
    '/api/overlay/exchange',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = readScopeSchema.safeParse(request.body);
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
    const scope = readScopeSchema.parse({
      worldId: params.data.id,
      channelId: query.data.channelId,
    });
    await authorizeRead(pool, scope, bearer(request.headers.authorization));
    const snapshot = await snapshotEnvelope(pool, scope.worldId, scope.channelId);
    if (snapshot === null) throw new ApiError('NOT_FOUND', 404, 'World is unavailable.');
    reply.header('cache-control', 'no-store');
    return snapshot;
  });
}
