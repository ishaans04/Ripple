import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import rateLimit from '@fastify/rate-limit';
import type { ServerConfig } from './config.ts';
import { registerErrorHandling } from './errors.ts';
import { loggerOptions, requestIdFrom, requestIdHeader, type LogDestination } from './logging.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerGameReadRoutes } from './routes/game-read.ts';
import { registerGateway } from './game/gateway.ts';
import { registerSecurityHeaders, registerWebApp } from './web.ts';
import { TwitchClient } from './twitch/client.ts';
import { ensureInstallation } from './twitch/installation.ts';
import { registerOAuth } from './twitch/oauth.ts';

export interface AppOptions {
  config: Pick<ServerConfig, 'logLevel' | 'webRoot' | 'twitch'>;
  pool: pg.Pool;
  /** Overrides stdout, used by tests to inspect log output. */
  logStream?: LogDestination;
  twitchApi?: TwitchClient;
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
  await app.register(rateLimit, { global: false, max: 60, timeWindow: '1 minute', cache: 10_000 });
  await registerGateway(app, options.pool);
  registerHealthRoutes(app, options.pool);
  registerGameReadRoutes(app, options.pool);
  if (options.config.twitch !== undefined) {
    const api = options.twitchApi ?? new TwitchClient(options.config.twitch);
    const worldId = await ensureInstallation(options.pool, options.config.twitch);
    await app.register(async (scope) => {
      registerOAuth(scope, options.pool, api, worldId);
    });
  }
  if (options.config.webRoot !== undefined) {
    await registerWebApp(app, options.config.webRoot);
  }
  return app;
}
