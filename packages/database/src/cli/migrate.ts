/**
 * Pre-deploy migration step: `node dist/cli/migrate.js` with DATABASE_URL set.
 * Emits one JSON line describing the outcome and exits non-zero on failure.
 */
import { createDatabase } from '../client.ts';
import { runMigrations } from '../migrate.ts';

function emit(level: 'info' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify({ level, time: new Date().toISOString(), msg, ...fields })}\n`);
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString === '') {
  emit('error', 'DATABASE_URL is required to run migrations');
  process.exit(1);
}

const database = createDatabase({
  connectionString,
  applicationName: 'ripple-migrate',
  maxConnections: 1,
  onIdleClientError: (error) => {
    emit('error', 'idle database client failed', { error: error.message });
  },
});

try {
  const result = await runMigrations(database.pool);
  emit('info', 'migrations complete', { ...result });
} catch (error) {
  emit('error', 'migrations failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  await database.close();
}
