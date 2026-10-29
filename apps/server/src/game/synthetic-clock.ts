import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { scanDeadlines, transaction } from '@ripple/database';
import type pg from 'pg';
import { authorizeSynthetic, SandboxError, type WorldScope } from './sandbox.ts';
import { processNextInput } from './worker.ts';

export async function settleSyntheticWorld(
  pool: pg.Pool,
  scope: WorldScope,
): Promise<{ processed: number; pending: boolean }> {
  const world = (
    await pool.query<{ mode: string; expired: boolean }>(
      'select mode,expires_at<=clock_timestamp() as expired from worlds where id=$1',
      [scope.worldId],
    )
  ).rows[0];
  if (world?.mode !== 'sandbox') throw new SandboxError('WRONG_WORLD_MODE');
  if (world.expired) throw new SandboxError('WORLD_EXPIRED');
  let processed = 0;
  for (let batch = 0; batch < 1000; batch++) {
    const delivered = await scanDeadlines(pool, randomUUID(), { worldId: scope.worldId });
    let count = 0;
    const channels = (
      await pool.query<{ id: string }>(
        'select id from channels where world_id=$1 and processed_sequence<intake_sequence order by id',
        [scope.worldId],
      )
    ).rows;
    for (const channel of channels) {
      for (let turn = 0; turn < 100; turn++) {
        if ((await processNextInput(pool, scope.worldId, channel.id)) === null) break;
        count++;
        processed++;
      }
    }
    if (delivered === 0 && count === 0) {
      const outstanding = (
        await pool.query<{ pending: boolean }>(
          `select
        exists(select 1 from deadlines d join worlds w on w.id=d.world_id where d.world_id=$1 and d.status in ('pending','leased') and d.due_at<=w.clock_at)
        or exists(select 1 from channels where world_id=$1 and processed_sequence<intake_sequence) as pending`,
          [scope.worldId],
        )
      ).rows[0]?.pending;
      if (!outstanding) return { processed, pending: false };
      // Another dispatcher may own a due lease without having appended its marker yet.
      await wait(10);
    }
  }
  return { processed, pending: true };
}
export async function advanceSyntheticClock(
  pool: pg.Pool,
  scope: WorldScope,
  owner: string,
  operationId: string,
  deltaMs: number,
): Promise<{
  toAtMs: number;
  operationId: string;
  duplicate: boolean;
  processed: number;
  pending: boolean;
}> {
  if (!Number.isSafeInteger(deltaMs) || deltaMs < 1 || deltaMs > 300_000)
    throw new Error('Advance must be an integer from 1 through 300000 milliseconds.');
  const step = await transaction(pool, async (client) => {
    const from = await authorizeSynthetic(client, scope, owner);
    const previous = (
      await client.query<{ delta_ms: number; to_at: Date; channel_id: string }>(
        'select delta_ms,to_at,channel_id from sandbox_clock_steps where world_id=$1 and operation_id=$2',
        [scope.worldId, operationId],
      )
    ).rows[0];
    if (previous !== undefined) {
      if (previous.delta_ms !== deltaMs || previous.channel_id !== scope.channelId)
        throw new Error('Operation ID was already used for a different clock change.');
      return { toAtMs: previous.to_at.getTime(), duplicate: true };
    }
    const to = new Date(from.getTime() + deltaMs);
    await client.query(
      'insert into sandbox_clock_steps (world_id,channel_id,operation_id,delta_ms,from_at,to_at) values ($1,$2,$3,$4,$5,$6)',
      [scope.worldId, scope.channelId, operationId, deltaMs, from, to],
    );
    await client.query('update worlds set clock_at=$2 where id=$1', [scope.worldId, to]);
    return { toAtMs: to.getTime(), duplicate: false };
  });
  return { ...step, operationId, ...(await settleSyntheticWorld(pool, scope)) };
}
