import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { ServerConfig } from './config.ts';
import { registerErrorHandling } from './errors.ts';
import { loggerOptions, requestIdFrom, requestIdHeader, type LogDestination } from './logging.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerSecurityHeaders, registerWebApp } from './web.ts';

export interface AppOptions {
  config: Pick<ServerConfig, 'logLevel' | 'webRoot'>;
  pool: pg.Pool;
  /** Overrides stdout, used by tests to inspect log output. */
  logStream?: LogDestination;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(options.config.logLevel, options.logStream),
    genReqId: (request) => requestIdFrom(request.headers[requestIdHeader]),
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    // Reject oversized bodies early; no Ripple request needs more than this.
    bodyLimit: 256 * 1024,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header(requestIdHeader, request.id);
  });

  registerErrorHandling(app);
  await registerSecurityHeaders(app);
  registerHealthRoutes(app, options.pool);
  if (options.config.webRoot !== undefined) {
    await registerWebApp(app, options.config.webRoot);
  }
  return app;
}
