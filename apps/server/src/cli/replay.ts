import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createDatabase } from '@ripple/database';
import { loadConfig } from '../config.ts';
import { runReplay, summarizeBundle } from '../game/replay-report.ts';
import { exportAcceptedWorld, type WorldReplay } from '../game/world-replay.ts';

const usage =
  "Usage: replay export WORLD [FILE] | replay verify FILE | replay run FILE. Export writes every channel's accepted records; verify checks checksum chains and dependencies; run rebuilds an isolated replay world and compares it with the source when present.";
const config = loadConfig(process.env);
const database = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: 'ripple-replay-cli',
  onIdleClientError: (error) => {
    process.stderr.write(`${error.message}\n`);
  },
});
async function load(file: string | undefined): Promise<WorldReplay> {
  if (file === undefined) throw new Error(usage);
  return JSON.parse(
    await readFile(resolve(process.env.INIT_CWD ?? process.cwd(), file), 'utf8'),
  ) as WorldReplay;
}
try {
  const [action, target, output] = process.argv.slice(2);
  if (action === 'export') {
    const world = await exportAcceptedWorld(database.pool, z.uuid().parse(target));
    const text = `${JSON.stringify(world, null, 2)}\n`;
    if (output === undefined) process.stdout.write(text);
    else {
      await writeFile(resolve(process.env.INIT_CWD ?? process.cwd(), output), text, 'utf8');
      process.stdout.write(`${JSON.stringify(summarizeBundle(world), null, 2)}\n`);
    }
  } else if (action === 'verify')
    process.stdout.write(
      `${JSON.stringify({ verified: true, ...summarizeBundle(await load(target)) }, null, 2)}\n`,
    );
  else if (action === 'run') {
    const report = await runReplay(database.pool, await load(target));
    process.stdout.write(`${JSON.stringify({ replay: true, ...report }, null, 2)}\n`);
    if (report.sourceComparison?.some((item) => !item.equal) === true) process.exitCode = 2;
  } else throw new Error(usage);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Replay failed.'}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
