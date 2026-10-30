import { z } from 'zod';
import { createDatabase } from '@ripple/database';
import { loadConfig } from '../config.ts';
import { computeMetrics } from '../game/metrics.ts';

const config = loadConfig(process.env);
const database = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: 'ripple-metrics-cli',
  onIdleClientError: (error) => {
    process.stderr.write(`${error.message}\n`);
  },
});
try {
  const [world, channel, population] = process.argv.slice(2);
  const report = await computeMetrics(
    database.pool,
    z.uuid().parse(world),
    channel === undefined || channel === 'all' ? null : z.uuid().parse(channel),
    z.enum(['live', 'sandbox']).default('live').parse(population),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Metrics failed.'}\nUsage: metrics WORLD [CHANNEL|all] [live|sandbox]\n`,
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
