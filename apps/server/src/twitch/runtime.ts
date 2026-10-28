import { randomUUID } from 'node:crypto';
import { acceptInputInTransaction, transaction } from '@ripple/database';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { TwitchClient, TwitchError } from './client.ts';
import { maintainGrant, type GrantRow } from './grants.ts';
import { reconcileSubscriptions } from './subscriptions.ts';
import { reconcileStreams } from './streams.ts';
import { dispatchBotMessage } from './bot.ts';

export async function interruptLiveInput(
  pool: pg.Pool,
  error: string,
  worldId?: string,
): Promise<void> {
  await transaction(pool, async (client) => {
    const channels = await client.query<{ world_id: string; id: string }>(
      `select c.world_id,c.id from channels c join worlds w on w.id=c.world_id where w.mode='live' and ($1::uuid is null or c.world_id=$1) order by c.world_id,c.id for update of c`,
      [worldId ?? null],
    );
    for (const channel of channels.rows) {
      const changed = await client.query(
        'update twitch_channels set input_error=$3 where world_id=$1 and channel_id=$2 and input_error is distinct from $3',
        [channel.world_id, channel.id, error],
      );
      if (changed.rowCount === 1)
        await acceptInputInTransaction(client, {
          worldId: channel.world_id,
          channelId: channel.id,
          provider: 'twitch-health',
          messageId: randomUUID(),
          command: { type: 'interrupt', reason: 'input_outage' },
          requiredMode: 'live',
        });
    }
  });
}
export async function runTwitchCycle(
  pool: pg.Pool,
  api: TwitchClient,
  world: string,
  startup = false,
): Promise<void> {
  const grants = await pool.query<GrantRow>(
    'select * from oauth_grants where world_id=$1 and revoked_at is null order by purpose,subject',
    [world],
  );
  for (const grant of grants.rows) await maintainGrant(pool, api, grant, startup);
  await reconcileSubscriptions(pool, api, world);
  await reconcileStreams(pool, api, world);
}
export function startTwitchRuntime(
  pool: pg.Pool,
  api: TwitchClient,
  world: string,
  logger: Pick<FastifyBaseLogger, 'warn'>,
): { stop: () => Promise<void> } {
  let stopped = false,
    startup = true,
    timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  let botPending: Promise<void> = Promise.resolve(),
    botTimer: ReturnType<typeof setTimeout> | undefined;
  function sendBot(): void {
    botPending = dispatchBotMessage(pool, api, world)
      .then(() => undefined)
      .catch(() => {
        logger.warn(
          { code: 'BOT_DISPATCH_FAILED' },
          'Bot delivery will be checked on the next cycle',
        );
      })
      .finally(() => {
        if (!stopped) botTimer = setTimeout(sendBot, 1000);
      });
  }
  function schedule(): void {
    pending = runTwitchCycle(pool, api, world, startup)
      .then(() => {
        startup = false;
      })
      .catch(async (error: unknown) => {
        const code = error instanceof TwitchError ? error.code : 'INTEGRATION_FAILED';
        logger.warn({ code }, 'Twitch reconciliation failed; live observation is held');
        try {
          await interruptLiveInput(pool, code, world);
        } catch {
          logger.warn(
            { code: 'INPUT_STATUS_UNAVAILABLE' },
            'Could not persist Twitch input failure',
          );
        }
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(schedule, 30000);
      });
  }
  schedule();
  sendBot();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(botTimer);
      await pending;
      await botPending;
    },
  };
}
