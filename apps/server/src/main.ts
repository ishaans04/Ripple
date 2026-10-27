import { createDatabase } from '@ripple/database';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig, type ServerConfig } from './config.ts';
import { createShutdown } from './shutdown.ts';
import { startGameRuntime } from './game/runtime.ts';

function readConfig(): ServerConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();

const database = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: 'ripple-server',
  onIdleClientError: (error) => {
    app.log.error({ err: error }, 'idle database client failed');
  },
});

const app = await buildApp({ config, pool: database.pool });
app.addHook('onClose', () => database.close());
const runtime = startGameRuntime(database.pool, app.log, () => {
  app.publicGateway.wake();
});
app.addHook('preClose', () => runtime.stop());

const shutdown = createShutdown({
  app,
  graceMs: config.shutdownGraceMs,
  exit: (code) => process.exit(code),
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}
process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection', 1);
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start listening');
  await shutdown('listenFailed', 1);
}
