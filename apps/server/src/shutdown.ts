import type { FastifyInstance } from 'fastify';

export interface ShutdownOptions {
  app: FastifyInstance;
  graceMs: number;
  exit: (code: number) => void;
}

/**
 * Returns an idempotent shutdown routine. Fastify stops accepting connections and
 * answers new requests with 503 while in-flight requests finish; onClose hooks then
 * release resources. A second request, or exceeding the grace period, forces exit.
 */
export function createShutdown({
  app,
  graceMs,
  exit,
}: ShutdownOptions): (reason: string, exitCode?: number) => Promise<void> {
  let inProgress = false;

  return async (reason, exitCode = 0) => {
    if (inProgress) {
      app.log.warn({ reason }, 'shutdown requested again; forcing exit');
      exit(1);
      return;
    }
    inProgress = true;
    app.log.info({ reason, graceMs }, 'shutting down');

    const deadline = setTimeout(() => {
      app.log.fatal({ graceMs }, 'shutdown grace period exceeded; forcing exit');
      exit(1);
    }, graceMs);
    deadline.unref();

    try {
      await app.close();
      clearTimeout(deadline);
      app.log.info('shutdown complete');
      exit(exitCode);
    } catch (error) {
      clearTimeout(deadline);
      app.log.error({ err: error }, 'shutdown failed');
      exit(1);
    }
  };
}
