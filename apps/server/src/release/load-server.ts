import { createDatabase } from '@ripple/database';
import { buildApp } from '../app.ts';
import { startGameRuntime } from '../game/runtime.ts';
import type { TwitchConfig } from '../twitch/security.ts';
const database = createDatabase({
  connectionString: process.env.DATABASE_URL ?? '',
  applicationName: 'ripple-release-load',
  maxConnections: 48,
  onIdleClientError: () => undefined,
});
process.once('message', (message: { config: TwitchConfig }) => {
  void (async () => {
    const app = await buildApp({
      config: { logLevel: 'error', webRoot: undefined, twitch: message.config },
      pool: database.pool,
    });
    let runtime = startGameRuntime(database.pool, app.log, () => {
      app.publicGateway.wake();
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    let peakWaiting = 0,
      peakBusyOrConnecting = 0;
    const poolSampler = setInterval(() => {
      peakWaiting = Math.max(peakWaiting, database.pool.waitingCount);
      peakBusyOrConnecting = Math.max(
        peakBusyOrConnecting,
        database.pool.totalCount - database.pool.idleCount,
      );
    }, 50);
    poolSampler.unref();
    process.send?.({ ready: true, address });
    process.on('message', (value: { action: string }) => {
      if (value.action === 'stop-worker')
        void runtime.stop().then(() => {
          process.send?.({ workerStopped: true });
        });
      if (value.action === 'restart-worker') {
        runtime = startGameRuntime(database.pool, app.log, () => {
          app.publicGateway.wake();
        });
        process.send?.({ workerRestarted: true });
      }
      if (value.action === 'stats')
        process.send?.({
          stats: true,
          cpu: process.cpuUsage(cpuStart),
          elapsedMs: performance.now() - started,
          memory: process.memoryUsage(),
          pool: { maxConnections: 48, sampleIntervalMs: 50, peakWaiting, peakBusyOrConnecting },
        });
      if (value.action === 'stop')
        void runtime
          .stop()
          .then(() => app.close())
          .then(() => database.close())
          .then(() => process.exit(0));
    });
  })().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Load server failed'}\n`);
    process.exit(1);
  });
});
