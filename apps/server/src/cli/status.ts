import { createDatabase } from '@ripple/database';
import { loadConfig } from '../config.ts';
import { operationalStatus } from '../operations/status.ts';
const db = createDatabase({
  connectionString: loadConfig(process.env).databaseUrl,
  applicationName: 'ripple-status',
  onIdleClientError: () => undefined,
});
try {
  process.stdout.write(`${JSON.stringify(await operationalStatus(db.pool), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Status unavailable'}\n`);
  process.exitCode = 1;
} finally {
  await db.close();
}
