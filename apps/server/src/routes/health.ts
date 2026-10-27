import type { LiveHealth, ReadyHealth } from '@ripple/contracts';
import { getMigrationStatus } from '@ripple/database';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type pg from 'pg';

async function checkReadiness(pool: pg.Pool, log: FastifyBaseLogger): Promise<ReadyHealth> {
  try {
    await pool.query('select 1');
  } catch (error) {
    log.warn({ err: error }, 'readiness: database unavailable');
    return { status: 'not_ready', checks: { database: 'unavailable', migrations: 'unknown' } };
  }

  let migrations: ReadyHealth['checks']['migrations'];
  try {
    migrations = await getMigrationStatus(pool);
  } catch (error) {
    log.warn({ err: error }, 'readiness: migration status unavailable');
    migrations = 'unknown';
  }

  return {
    status: migrations === 'current' ? 'ready' : 'not_ready',
    checks: { database: 'ok', migrations },
  };
}

export function registerHealthRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/health/live', (_request, reply) => {
    const body: LiveHealth = { status: 'ok' };
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.get('/health/ready', async (request, reply) => {
    const report = await checkReadiness(pool, request.log);
    return reply
      .code(report.status === 'ready' ? 200 : 503)
      .header('cache-control', 'no-store')
      .send(report);
  });
}
