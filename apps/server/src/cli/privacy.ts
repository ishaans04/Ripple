import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createDatabase } from '@ripple/database';
import { loadConfig } from '../config.ts';
import { forgetArtist } from '../privacy/credits.ts';
import { maintainData, purgeExpiredWorld } from '../privacy/maintenance.ts';
import { exportErasureLedger, applyErasureLedger } from '../privacy/ledger.ts';
const database = createDatabase({
  connectionString: loadConfig(process.env).databaseUrl,
  applicationName: 'ripple-privacy',
  onIdleClientError: (error) => {
    process.stderr.write(`${error.message}\n`);
  },
});
try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { apply: { type: 'boolean' }, confirm: { type: 'string' } },
  });
  const [action, world, artist] = positionals;
  if (action === 'export-ledger' || action === 'apply-ledger') {
    if (!world) throw new Error('Provide a ledger file path.');
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), world);
    if (action === 'export-ledger') {
      const ledger = await exportErasureLedger(database.pool);
      await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
      process.stdout.write(`${JSON.stringify({ exported: ledger.erasures.length, path })}\n`);
    } else {
      if (!values.apply || values.confirm !== 'erasures')
        throw new Error('Use --apply --confirm erasures to reapply the reviewed erasure ledger.');
      process.stdout.write(
        `${JSON.stringify(await applyErasureLedger(database.pool, JSON.parse(await readFile(path, 'utf8'))))}\n`,
      );
    }
  } else if (action === 'maintain') {
    if (!values.apply)
      throw new Error('Use maintain --apply to run the documented retention policy.');
    process.stdout.write(`${JSON.stringify(await maintainData(database.pool))}\n`);
  } else {
    const worldId = z.uuid().parse(world);
    if (!values.apply || values.confirm !== worldId)
      throw new Error(
        'Provide --apply --confirm WORLD_UUID after reviewing the exact deletion scope.',
      );
    if (action === 'forget-artist')
      process.stdout.write(
        `${JSON.stringify(
          await forgetArtist(
            database.pool,
            worldId,
            z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(artist),
          ),
        )}\n`,
      );
    else if (action === 'purge-world')
      process.stdout.write(`${JSON.stringify(await purgeExpiredWorld(database.pool, worldId))}\n`);
    else
      throw new Error(
        'Usage: privacy maintain --apply | forget-artist WORLD ARTIST_KEY --apply --confirm WORLD | purge-world EXPIRED_WORLD --apply --confirm WORLD',
      );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Privacy command failed'}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
