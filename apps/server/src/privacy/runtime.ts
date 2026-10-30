import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { maintainData, purgeExpiredSyntheticWorlds } from './maintenance.ts';
export function startMaintenance(pool: pg.Pool, logger: Pick<FastifyBaseLogger, 'error'>) {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const cycle = () => {
    pending = (async () => {
      await maintainData(pool);
      await purgeExpiredSyntheticWorlds(pool);
    })()
      .catch((error: unknown) => {
        logger.error({ err: error }, 'data maintenance failed; records retained for retry');
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(cycle, 30_000);
      });
  };
  timer = setTimeout(cycle, 30_000);
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await pending;
    },
  };
}
