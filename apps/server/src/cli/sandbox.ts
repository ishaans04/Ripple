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
import { createSyntheticPeer } from '../game/synthetic-peer.ts';
import { operationId } from '../game/operation-id.ts';

const usage =
  'Usage: sandbox create | peer WORLD CHANNEL LABEL [PEER_UUID] | status/seed/prepare/enable-mechanics/clear-traces/pause/resume/offline/online/input-outage/recover WORLD CHANNEL | traces WORLD CHANNEL true/false | raid/raid-unknown WORLD SOURCE DESTINATION_UUID [RECEIPT_UUID] | policy WORLD CHANNEL ask/accept/reject | admit/decline/claim WORLD CHANNEL TRANSFER VERSION | block-source/block-lineage WORLD CHANNEL ID true/false | vote WORLD CHANNEL ACTOR CHOICE | activity WORLD CHANNEL ACTOR | advance WORLD CHANNEL MS [OPERATION_UUID]. Set RIPPLE_SANDBOX_CAPABILITY for existing worlds.';
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
    const world = await createSyntheticWorld(database.pool, { mechanicsVersion: 1 });
    await acceptSyntheticCommand(
      database.pool,
      world,
      world.ownerCapability,
      randomUUID(),
      syntheticSeedCommand(),
    );
    const settlement = await settleSyntheticWorld(database.pool, world);
    process.stdout.write(
      `${JSON.stringify({ synthetic: true, ...world, settlement, snapshot: await snapshotEnvelope(database.pool, world.worldId, world.channelId) }, null, 2)}\n`,
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
    let settlement: { processed: number; pending: boolean } | undefined;
    if (action === 'peer')
      result = await createSyntheticPeer(
        database.pool,
        scope,
        owner,
        extra === undefined ? randomUUID() : z.uuid().parse(extra),
        z.string().parse(value),
      );
    else if (action === 'advance')
      result = await advanceSyntheticClock(
        database.pool,
        scope,
        owner,
        extra === undefined ? randomUUID() : z.uuid().parse(extra),
        z.coerce.number().int().min(1).max(300_000).parse(value),
      );
    else if (action !== 'status') {
      let command: unknown;
      let receiptId: string = randomUUID();
      switch (action) {
        case 'seed':
          command = syntheticSeedCommand();
          break;
        case 'prepare':
          command = { type: 'prepare' };
          break;
        case 'enable-mechanics':
          command = { type: 'enableMechanics' };
          break;
        case 'clear-traces':
          command = { type: 'clearTrace' };
          break;
        case 'traces':
          command = {
            type: 'setTraces',
            enabled: z.enum(['true', 'false']).parse(value) === 'true',
          };
          break;
        case 'raid':
        case 'raid-unknown':
          receiptId = extra === undefined ? randomUUID() : z.uuid().parse(extra);
          command = {
            type: 'raid',
            transferId: operationId(scope.channelId, 0, `${receiptId}:transfer`),
            childId: operationId(scope.channelId, 0, `${receiptId}:child`),
            residencyId: operationId(scope.channelId, 0, `${receiptId}:residency`),
            arrivalRoundId: operationId(scope.channelId, 0, `${receiptId}:welcome`),
            destinationChannelId: action === 'raid-unknown' ? null : z.uuid().parse(value),
            destinationTwitchId: z.uuid().parse(value).toLowerCase(),
            retainUnenrolled: true,
          };
          break;
        case 'policy': {
          const snapshot = await snapshotEnvelope(database.pool, scope.worldId, scope.channelId);
          if (snapshot === null) throw new Error('Synthetic channel missing.');
          command = {
            type: 'policy',
            visitorPolicy: z.enum(['ask', 'accept', 'reject']).parse(value),
            expectedVersion: snapshot.stateVersion,
          };
          break;
        }
        case 'admit':
        case 'decline':
          command = {
            type: 'admission',
            transferId: z.uuid().parse(value),
            transferVersion: z.coerce.number().int().nonnegative().parse(extra),
            decision: action === 'admit' ? 'accept' : 'decline',
            roundId: randomUUID(),
          };
          break;
        case 'claim':
          command = {
            type: 'claimRaid',
            transferId: z.uuid().parse(value),
            transferVersion: z.coerce.number().int().nonnegative().parse(extra),
          };
          break;
        case 'block-source':
        case 'block-lineage':
          command = {
            type: action === 'block-source' ? 'blockSource' : 'blockLineage',
            ...(action === 'block-source'
              ? { sourceChannelId: z.uuid().parse(value) }
              : { lineageId: z.uuid().parse(value) }),
            blocked: z.enum(['true', 'false']).parse(extra) === 'true',
          };
          break;
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
      result = {
        receiptId,
        ...(await acceptSyntheticCommand(database.pool, scope, owner, receiptId, command)),
      };
      settlement = await settleSyntheticWorld(database.pool, scope);
    }
    process.stdout.write(
      `${JSON.stringify({ synthetic: true, result, settlement, snapshot: await snapshotEnvelope(database.pool, scope.worldId, scope.channelId) }, null, 2)}\n`,
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Synthetic action failed.'}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
