import { acceptInputInTransaction, transaction } from '@ripple/database';
import { canonicalJson, sha256Hex } from '@ripple/engine';
import { strainNameSchema, type GameCommand } from '@ripple/contracts';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { readSnapshot } from '../game/snapshot.ts';
import { syntheticSeedCommand } from '../game/sandbox.ts';
import { cookie, ControlError, ownerSession } from './sessions.ts';
import { opaqueToken, type TwitchConfig } from './security.ts';
import { subscriptionVersions } from './webhook.ts';

const seedBody = z.strictObject({ expectedVersion: z.int().nonnegative(), name: strainNameSchema });
const versionBody = z.strictObject({ expectedVersion: z.int().nonnegative() });
const renameBody = seedBody.extend({ organismId: z.uuid() });
const policyBody = versionBody.extend({ visitorPolicy: z.enum(['ask', 'accept', 'reject']) });
export function registerController(
  app: FastifyInstance,
  pool: pg.Pool,
  config: TwitchConfig,
): void {
  app.get(
    '/api/controller/status',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request) => {
      const owner = await ownerSession(pool, request, config);
      const snapshot = await readSnapshot(pool, owner.world_id, owner.channel_id);
      const settings = (
        await pool.query<{
          input_error: string | null;
          visitor_policy: 'ask' | 'accept' | 'reject';
          last_seed_at: Date | null;
          seed_cooldown_ms: number;
        }>(
          'select input_error,visitor_policy,last_seed_at,seed_cooldown_ms from twitch_channels where world_id=$1 and channel_id=$2',
          [owner.world_id, owner.channel_id],
        )
      ).rows[0];
      const subscriptions = (
        await pool.query<{
          type: string;
          version: string;
          status: string;
          cost: number;
          verified_at: Date | null;
        }>(
          'select type,version,status,cost,verified_at from twitch_subscriptions where world_id=$1 and channel_id=$2 order by type',
          [owner.world_id, owner.channel_id],
        )
      ).rows;
      const bot =
        (
          await pool.query(
            "select 1 from oauth_grants where world_id=$1 and purpose='bot' and revoked_at is null and expires_at>clock_timestamp() and validated_at>clock_timestamp()-interval '1 hour'",
            [owner.world_id],
          )
        ).rowCount === 1;
      return {
        worldId: owner.world_id,
        channelId: owner.channel_id,
        csrfToken: cookie(request, '__Host-ripple-csrf'),
        authorized: true,
        botAuthorized: bot,
        callbackReady: subscriptions.some((s) => s.verified_at !== null),
        subscriptionsReady: Object.entries(subscriptionVersions).every(([type, version]) =>
          subscriptions.some(
            (s) =>
              s.type === type &&
              s.version === version &&
              s.status === 'enabled' &&
              s.verified_at !== null,
          ),
        ),
        subscriptions,
        settings,
        snapshot,
        readClients: app.publicGateway.connected(owner.world_id, owner.channel_id),
      };
    },
  );
  app.get('/api/controller/commands/:key', async (request) => {
    const owner = await ownerSession(pool, request, config),
      key = z.uuid().safeParse((request.params as { key: unknown }).key);
    if (!key.success) throw new ControlError(400, 'BAD_REQUEST');
    const row = (
      await pool.query<{ sequence: number; result: unknown }>(
        `select o.sequence,e.result from controller_operations o left join game_events e on e.world_id=o.world_id and e.channel_id=o.channel_id and e.sequence=o.sequence where o.world_id=$1 and o.channel_id=$2 and o.key=$3`,
        [owner.world_id, owner.channel_id, key.data],
      )
    ).rows[0];
    if (row === undefined) throw new ControlError(404, 'NOT_FOUND');
    return row;
  });
  for (const action of ['seed', 'rename', 'pause', 'resume', 'recover', 'policy'] as const) {
    app.post(
      `/api/channels/:id/${action}`,
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const owner = await ownerSession(pool, request, config, true);
        if ((request.params as { id: string }).id !== owner.channel_id)
          throw new ControlError(403, 'NOT_OWNER');
        const key = z.uuid().safeParse(request.headers['idempotency-key']);
        if (!key.success) throw new ControlError(400, 'IDEMPOTENCY_KEY_REQUIRED');
        const schema =
          action === 'seed'
            ? seedBody
            : action === 'rename'
              ? renameBody
              : action === 'policy'
                ? policyBody
                : versionBody;
        const parsed = schema.safeParse(request.body);
        if (!parsed.success) throw new ControlError(400, 'BAD_REQUEST');
        const body = parsed.data,
          hash = sha256Hex(canonicalJson({ action, body }));
        const receipt = await transaction(pool, async (client) => {
          await client.query('select id from channels where world_id=$1 and id=$2 for update', [
            owner.world_id,
            owner.channel_id,
          ]);
          const previous = (
            await client.query<{ request_hash: string; sequence: number }>(
              'select request_hash,sequence from controller_operations where world_id=$1 and channel_id=$2 and key=$3',
              [owner.world_id, owner.channel_id, key.data],
            )
          ).rows[0];
          if (previous !== undefined) {
            if (previous.request_hash !== hash) throw new ControlError(409, 'IDEMPOTENCY_CONFLICT');
            return { sequence: previous.sequence, duplicate: true };
          }
          const channel = (
            await client.query<{ state_version: number }>(
              'select state_version from channels where world_id=$1 and id=$2',
              [owner.world_id, owner.channel_id],
            )
          ).rows[0];
          if (channel?.state_version !== body.expectedVersion)
            throw new ControlError(409, 'STALE_VERSION');
          if (action === 'seed') {
            const allowed = await client.query(
              "select 1 from twitch_channels where world_id=$1 and channel_id=$2 and (last_seed_at is null or last_seed_at+seed_cooldown_ms*interval '1 millisecond'<=clock_timestamp())",
              [owner.world_id, owner.channel_id],
            );
            if (allowed.rowCount !== 1) throw new ControlError(409, 'SEED_COOLDOWN');
            const pending = await client.query(
              "select 1 from inbox where world_id=$1 and channel_id=$2 and processed_at is null and command->>'type'='seed'",
              [owner.world_id, owner.channel_id],
            );
            if (pending.rowCount !== 0) throw new ControlError(409, 'COMMAND_PENDING');
          }
          let command: GameCommand;
          if (action === 'seed')
            command = {
              ...syntheticSeedCommand(),
              name: seedBody.parse(body).name,
              expectedVersion: body.expectedVersion,
            };
          else if (action === 'rename') {
            const rename = renameBody.parse(body);
            command = { type: 'rename', ...rename };
          } else if (action === 'policy') command = { type: 'policy', ...policyBody.parse(body) };
          else
            command =
              action === 'pause'
                ? { type: 'pause', reason: 'manual', expectedVersion: body.expectedVersion }
                : { type: action, expectedVersion: body.expectedVersion };
          const accepted = await acceptInputInTransaction(client, {
            worldId: owner.world_id,
            channelId: owner.channel_id,
            provider: 'controller',
            messageId: `${owner.channel_id}:${key.data}`,
            command,
            requiredMode: 'live',
          });
          await client.query(
            'insert into controller_operations(world_id,channel_id,key,request_hash,sequence) values($1,$2,$3,$4,$5)',
            [owner.world_id, owner.channel_id, key.data, hash, accepted.sequence],
          );
          return accepted;
        });
        return reply.code(202).send({ operationId: key.data, ...receipt });
      },
    );
  }
  app.post(
    '/api/controller/read-capability',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request) => {
      const owner = await ownerSession(pool, request, config, true);
      const capability = opaqueToken();
      await transaction(pool, async (client) => {
        await client.query('select id from channels where world_id=$1 and id=$2 for update', [
          owner.world_id,
          owner.channel_id,
        ]);
        await client.query(
          'update overlay_capabilities set revoked_at=clock_timestamp() where world_id=$1 and channel_id=$2 and revoked_at is null',
          [owner.world_id, owner.channel_id],
        );
        await client.query(
          'insert into overlay_capabilities(hash,world_id,channel_id) values($1,$2,$3)',
          [sha256Hex(capability), owner.world_id, owner.channel_id],
        );
      });
      return { worldId: owner.world_id, channelId: owner.channel_id, capability };
    },
  );
}
