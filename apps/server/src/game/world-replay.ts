import { randomUUID } from 'node:crypto';
import { transaction } from '@ripple/database';
import { z } from 'zod';
import type pg from 'pg';
import {
  ReplayIntegrityError,
  canonicalGameProjection,
  createReplayChannel,
  exportAcceptedChannel,
  replayRecord,
  verifyAcceptedRecords,
  type AcceptedRecord,
  type ChannelReplay,
} from './replay.ts';

/** Every channel's accepted records; cross-channel dependencies define the replay order. */
export interface WorldReplay {
  schemaVersion: 1;
  sourceWorldId: string;
  channels: readonly ChannelReplay[];
}

// A raid records the destination positions it observed; an arrival records its source raid.
const raidDependency = z.object({
  channelId: z.uuid(),
  processedSequence: z.int().nonnegative(),
  intakeSequence: z.int().nonnegative(),
});
const sourceDependency = z.object({ channelId: z.uuid(), sequence: z.int().positive() });

export async function exportAcceptedWorld(pool: pg.Pool, worldId: string): Promise<WorldReplay> {
  const channels = (
    await pool.query<{ id: string }>(
      'select id from channels where world_id=$1 order by created_at,id',
      [worldId],
    )
  ).rows;
  if (channels.length === 0) throw new ReplayIntegrityError('World has no channels.');
  const bundles: ChannelReplay[] = [];
  for (const channel of channels)
    bundles.push(await exportAcceptedChannel(pool, { worldId, channelId: channel.id }));
  const sourceWorldId = bundles[0]?.sourceWorldId;
  if (sourceWorldId === undefined) throw new ReplayIntegrityError('World identity is missing.');
  const world: WorldReplay = { schemaVersion: 1, sourceWorldId, channels: bundles };
  verifyAcceptedWorld(world);
  return world;
}

/** Each channel chain verifies alone; every dependency must point inside the exported history. */
export function verifyAcceptedWorld(world: WorldReplay): void {
  z.literal(1).parse(world.schemaVersion);
  z.uuid().parse(world.sourceWorldId);
  if (world.channels.length === 0)
    throw new ReplayIntegrityError('World has no channel histories.');
  const lengths = new Map<string, number>();
  for (const channel of world.channels) {
    verifyAcceptedRecords(channel);
    if (channel.sourceWorldId !== undefined && channel.sourceWorldId !== world.sourceWorldId)
      throw new ReplayIntegrityError('Channel exports come from different worlds.');
    if (lengths.has(channel.channelId)) throw new ReplayIntegrityError('Duplicate channel export.');
    lengths.set(channel.channelId, channel.records.length);
  }
  for (const channel of world.channels)
    for (const record of channel.records)
      for (const dependency of record.dependencies) {
        const target = z.object({ channelId: z.uuid() }).parse(dependency).channelId;
        if (!lengths.has(target))
          throw new ReplayIntegrityError(
            `Sequence ${record.sequence} depends on a channel missing from the export.`,
          );
        const length = lengths.get(target) ?? 0;
        const raid = raidDependency.safeParse(dependency);
        if (raid.success) {
          if (
            raid.data.processedSequence > raid.data.intakeSequence ||
            raid.data.intakeSequence > length
          )
            throw new ReplayIntegrityError(
              'Raid dependency is outside the exported history; drain accepted inputs before exporting.',
            );
        } else {
          const source = sourceDependency.safeParse(dependency);
          if (!source.success) throw new ReplayIntegrityError('Unknown cross-channel dependency.');
          if (source.data.sequence > length)
            throw new ReplayIntegrityError('Source dependency is outside the exported history.');
        }
      }
}

interface Cursor {
  bundle: ChannelReplay;
  next: number;
}
function ready(
  record: AcceptedRecord,
  cursors: ReadonlyMap<string, Cursor>,
  intake: (id: string) => number,
): boolean {
  return record.dependencies.every((dependency) => {
    const raid = raidDependency.safeParse(dependency);
    if (raid.success) {
      const target = cursors.get(raid.data.channelId);
      // The raid must see exactly the destination state it saw originally.
      return (
        target?.next === raid.data.processedSequence &&
        intake(raid.data.channelId) === raid.data.intakeSequence
      );
    }
    const source = sourceDependency.safeParse(dependency);
    if (source.success) {
      const target = cursors.get(source.data.channelId);
      return target !== undefined && target.next >= source.data.sequence;
    }
    throw new ReplayIntegrityError('Unknown cross-channel dependency.');
  });
}

/**
 * Rebuilds a whole world in one isolated replay world. Records apply in each channel's order;
 * across channels, the earliest accepted ready record goes next. A cycle or a dependency the
 * history cannot satisfy is reported, never guessed around.
 */
export async function replayAcceptedWorld(
  pool: pg.Pool,
  world: WorldReplay,
): Promise<{ worldId: string; channelIds: string[] }> {
  verifyAcceptedWorld(world);
  const first = world.channels[0];
  if (first === undefined) throw new ReplayIntegrityError('World has no channels.');
  const worldId = randomUUID();
  await transaction(pool, async (client) => {
    await client.query(
      `insert into worlds (id,mode,rules_hash,expires_at,replay_of) values ($1,'replay',$2,clock_timestamp()+interval '1 day',$3)`,
      [worldId, first.rulesHash, world.sourceWorldId],
    );
    for (const channel of world.channels) await createReplayChannel(client, worldId, channel);
  });
  const cursors = new Map<string, Cursor>(
    world.channels.map((bundle) => [bundle.channelId, { bundle, next: 0 }]),
  );
  const intakes = new Map<string, number>();
  const refreshIntakes = async () => {
    for (const row of (
      await pool.query<{ id: string; intake_sequence: number }>(
        'select id,intake_sequence from channels where world_id=$1',
        [worldId],
      )
    ).rows)
      intakes.set(row.id, row.intake_sequence);
  };
  await refreshIntakes();
  for (;;) {
    const candidates = [...cursors.values()].flatMap((cursor) => {
      const record = cursor.bundle.records[cursor.next];
      return record === undefined ? [] : [{ cursor, record }];
    });
    if (candidates.length === 0) break;
    const next = candidates
      .filter(({ record }) => ready(record, cursors, (id) => intakes.get(id) ?? 0))
      .sort(
        (a, b) =>
          a.record.acceptedAtMs - b.record.acceptedAtMs ||
          (a.cursor.bundle.channelId < b.cursor.bundle.channelId ? -1 : 1),
      )[0];
    if (next === undefined)
      throw new ReplayIntegrityError(
        'Cross-channel dependencies cannot be satisfied in any order.',
      );
    await replayRecord(pool, worldId, next.cursor.bundle.channelId, next.record);
    next.cursor.next++;
    await refreshIntakes();
  }
  return { worldId, channelIds: world.channels.map((channel) => channel.channelId) };
}

/** Per-channel canonical equality between a source world and its replay. */
export async function compareWorldReplay(
  pool: pg.Pool,
  sourceWorldId: string,
  replayWorldId: string,
  channelIds: readonly string[],
): Promise<{ channelId: string; equal: boolean }[]> {
  const results: { channelId: string; equal: boolean }[] = [];
  for (const channelId of channelIds)
    results.push({
      channelId,
      equal:
        (await canonicalGameProjection(pool, { worldId: sourceWorldId, channelId })) ===
        (await canonicalGameProjection(pool, { worldId: replayWorldId, channelId })),
    });
  return results;
}
