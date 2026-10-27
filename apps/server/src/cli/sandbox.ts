import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDatabase, transaction } from '@ripple/database';
import { canonicalJson, sha256Hex } from '@ripple/engine';
import { loadConfig } from '../config.ts';
import {
  acceptSyntheticCommand,
  authorizeSynthetic,
  createSyntheticWorld,
  syntheticSeedCommand,
} from '../game/sandbox.ts';
import { advanceSyntheticClock, settleSyntheticWorld } from '../game/synthetic-clock.ts';
import { snapshotEnvelope } from '../game/snapshot.ts';

const usage =
  'Usage: sandbox create | status WORLD CHANNEL | vote WORLD CHANNEL ACTOR CHOICE | activity WORLD CHANNEL ACTOR | advance WORLD CHANNEL MS [OPERATION_UUID] | pause/resume/offline/online/input-outage/recover WORLD CHANNEL. Set RIPPLE_SANDBOX_CAPABILITY for existing worlds.';
const config = loadConfig(process.env);
const database = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: 'ripple-synthetic-cli',
  onIdleClientError: (error) => {
    process.stderr.write(`${error.message}\n`);
  },
});
try {
  const [action, worldId, channelId, value, extra] = process.argv.slice(2);
  if (action === 'create') {
    const world = await createSyntheticWorld(database.pool);
    await acceptSyntheticCommand(
      database.pool,
      world,
      world.ownerCapability,
      randomUUID(),
      syntheticSeedCommand(),
    );
    await settleSyntheticWorld(database.pool, world);
    process.stdout.write(
      `${JSON.stringify({ synthetic: true, ...world, snapshot: await snapshotEnvelope(database.pool, world.worldId, world.channelId) }, null, 2)}\n`,
    );
  } else {
    const scope = z
      .strictObject({ worldId: z.uuid(), channelId: z.uuid() })
      .parse({ worldId, channelId });
    const owner = process.env.RIPPLE_SANDBOX_CAPABILITY;
    if (owner === undefined) throw new Error('RIPPLE_SANDBOX_CAPABILITY is required.');
    await transaction(database.pool, async (client) => {
      await authorizeSynthetic(client, scope, owner);
    });
    let result: unknown;
    if (action === 'advance')
      result = await advanceSyntheticClock(
        database.pool,
        scope,
        owner,
        extra === undefined ? randomUUID() : z.uuid().parse(extra),
        z.coerce.number().int().min(1).max(300_000).parse(value),
      );
    else if (action !== 'status') {
      let command: unknown;
      switch (action) {
        case 'vote':
        case 'activity': {
          const actor = z.string().min(1).max(64).parse(value);
          const actorKey = sha256Hex(
            canonicalJson({ worldId: scope.worldId, syntheticActor: actor }),
          );
          command =
            action === 'vote'
              ? {
                  type: 'vote',
                  actorKey,
                  choice: z.coerce.number().int().min(1).max(3).parse(extra),
                }
              : { type: 'activity', actorKey };
          break;
        }
        case 'pause':
          command = { type: 'pause', reason: 'manual' };
          break;
        case 'resume':
        case 'recover':
          command = { type: action };
          break;
        case 'offline':
        case 'online':
          command = { type: 'integration', online: action === 'online', healthy: true };
          break;
        case 'input-outage':
          command = { type: 'interrupt', reason: 'input_outage' };
          break;
        case undefined:
        default:
          throw new Error(usage);
      }
      result = await acceptSyntheticCommand(database.pool, scope, owner, randomUUID(), command);
      await settleSyntheticWorld(database.pool, scope);
    }
    process.stdout.write(
      `${JSON.stringify({ synthetic: true, result, snapshot: await snapshotEnvelope(database.pool, scope.worldId, scope.channelId) }, null, 2)}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Synthetic action failed.'}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
