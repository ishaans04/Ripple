import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ServerConfig } from './config.ts';
import { registerErrorHandling } from './errors.ts';
import { loggerOptions, requestIdFrom, requestIdHeader, type LogDestination } from './logging.ts';
import { registerHealthRoutes } from './routes/health.ts';

export interface AppOptions {
  config: Pick<ServerConfig, 'logLevel'>;
  pool: pg.Pool;
  /** Overrides stdout, used by tests to inspect log output. */
  logStream?: LogDestination;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(options.config.logLevel, options.logStream),
    genReqId: (request) => requestIdFrom(request.headers[requestIdHeader]),
    requestIdLogLabel: 'requestId',
    // Reject oversized bodies early; no Ripple request needs more than this.
    bodyLimit: 256 * 1024,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header(requestIdHeader, request.id);
  });

  registerErrorHandling(app);
  registerHealthRoutes(app, options.pool);
  return app;
}
