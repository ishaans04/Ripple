import { randomUUID } from 'node:crypto';
import {
  acceptInput,
  acquireRuntimeLease,
  releaseRuntimeLease,
  scanDeadlines,
} from '@ripple/database';
import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { processNextInput } from './worker.ts';
import { processActivityBatch } from './activity-worker.ts';

interface ScopeRow {
  world_id: string;
  id: string;
}
async function recordLiveBoundary(
  pool: pg.Pool,
  owner: string,
  type: 'interrupt' | 'pause',
): Promise<void> {
  const channels =
    await pool.query<ScopeRow>(`select c.world_id,c.id from channels c join worlds w on w.id=c.world_id
    join rounds r on r.world_id=c.world_id and r.channel_id=c.id and r.completed_at is null and r.kind<>'STUDIO_SELECTION'
    where w.mode='live' and c.online and c.healthy and not c.paused and r.checkpoint->'clock'->>'paused'='false'
    order by c.world_id,c.id`);
  for (const channel of channels.rows)
    await acceptInput(pool, {
      worldId: channel.world_id,
      channelId: channel.id,
      provider: 'runtime',
      messageId: `${type}:${owner}:${channel.id}`,
      command:
        type === 'interrupt' ? { type, reason: 'process_gap' } : { type, reason: 'shutdown' },
      requiredMode: 'live',
    });
}
export async function runGameCycle(
  pool: pg.Pool,
  owner: string,
  logger: Pick<FastifyBaseLogger, 'error'>,
  committed: () => void = () => undefined,
): Promise<number> {
  const lease = await acquireRuntimeLease(pool, owner);
  if (!lease.acquired) return 0;
  if (lease.takeover) await recordLiveBoundary(pool, owner, 'interrupt');
  // A process-gap marker must precede every newly dispatched overdue cutoff.
  await scanDeadlines(pool, owner);
  const channels =
    await pool.query<ScopeRow>(`select c.world_id,c.id from channels c join worlds w on w.id=c.world_id
    where c.processed_sequence<c.intake_sequence and w.mode<>'replay' and (w.expires_at is null or w.expires_at>clock_timestamp()) order by c.world_id,c.id limit 128`);
  let processed = 0;
  let next = 0;
  const leaseState = { alive: true };
  const ownsLease = (): boolean => leaseState.alive;
  let renewing = false;
  let renewal: Promise<void> = Promise.resolve();
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    renewal = acquireRuntimeLease(pool, owner)
      .then((result) => {
        leaseState.alive = result.acquired;
      })
      .catch((error: unknown) => {
        leaseState.alive = false;
        logger.error({ err: error }, 'runtime lease renewal failed');
      })
      .finally(() => {
        renewing = false;
      });
  }, 1000);
  heartbeat.unref();
  const processChannels = async () => {
    while (next < channels.rows.length) {
      const channel = channels.rows[next++];
      if (channel === undefined || !ownsLease()) return;
      try {
        // A bounded batch per channel prevents a large chat from starving its neighbors.
        for (let count = 0; count < 4 && ownsLease(); count++) {
          const activities = await processActivityBatch(
            pool,
            channel.world_id,
            channel.id,
            4 - count,
          );
          if (activities !== null) {
            if (activities.length === 0) break;
            processed += activities.length;
            count += activities.length - 1;
            continue;
          }
          const result = await processNextInput(pool, channel.world_id, channel.id);
          if (result === null) break;
          processed++;
          if (result.effect.updateType !== null) committed();
        }
      } catch (error) {
        // Failure metadata does not advance the ordered cursor or discard its input.
        await pool.query(
          `update inbox set attempts=attempts+1,error_code='PROCESSING_FAILED' where world_id=$1 and channel_id=$2 and sequence=(select processed_sequence+1 from channels where world_id=$1 and id=$2)`,
          [channel.world_id, channel.id],
        );
        logger.error(
          { err: error, worldId: channel.world_id, channelId: channel.id },
          'ordered channel processing failed',
        );
      }
    }
  };
  // Independent channels may make progress together. processNextInput still takes the sorted
  // transaction lock set (including both sides of a raid), so per-channel replay stays ordered.
  try {
    await Promise.all(Array.from({ length: Math.min(24, channels.rows.length) }, processChannels));
  } finally {
    clearInterval(heartbeat);
    await renewal;
  }
  return processed;
}
export function startGameRuntime(
  pool: pg.Pool,
  logger: Pick<FastifyBaseLogger, 'error'>,
  committed?: () => void,
): { stop: () => Promise<void> } {
  const owner = randomUUID();
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  function schedule(): void {
    pending = runGameCycle(pool, owner, logger, committed)
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error({ err: error }, 'game runtime cycle failed');
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(schedule, 100);
      });
  }
  schedule();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await pending;
      const lease = await acquireRuntimeLease(pool, owner);
      if (!lease.acquired) return;
      try {
        await recordLiveBoundary(pool, owner, 'pause');
        // Persist the checkpoint before releasing ownership. A forced exit is repaired as a gap.
        for (let batch = 0; batch < 16; batch++)
          if ((await runGameCycle(pool, owner, logger, committed)) === 0) break;
      } finally {
        await releaseRuntimeLease(pool, owner);
      }
    },
  };
}
