import { createDatabase } from '@ripple/database';
import { buildApp } from '../app.ts';
import { startGameRuntime } from '../game/runtime.ts';
import type { TwitchConfig } from '../twitch/security.ts';
const database = createDatabase({
  connectionString: process.env.DATABASE_URL ?? '',
  applicationName: 'ripple-release-load',
  maxConnections: 32,
  onIdleClientError: () => undefined,
});
process.once('message', (message: { config: TwitchConfig }) => {
  void (async () => {
    const app = await buildApp({
      config: { logLevel: 'error', webRoot: undefined, twitch: message.config },
      pool: database.pool,
    });
    const runtime = startGameRuntime(database.pool, app.log, () => {
      app.publicGateway.wake();
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    process.send?.({ ready: true, address });
    process.on('message', (value: { action: string }) => {
      if (value.action === 'stats')
        process.send?.({
          stats: true,
          cpu: process.cpuUsage(cpuStart),
          elapsedMs: performance.now() - started,
          memory: process.memoryUsage(),
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
