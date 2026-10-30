import { randomBytes } from 'node:crypto';
import { sha256Hex } from '@ripple/engine';
import type pg from 'pg';
import {
  compareWorldReplay,
  replayAcceptedWorld,
  verifyAcceptedWorld,
  type WorldReplay,
} from './world-replay.ts';

export interface ReplayReport {
  replayWorldId: string;
  sourceWorldId: string;
  /** Null when the source world is not in this database; the checksum chain still applied. */
  sourceComparison: { channelId: string; equal: boolean }[] | null;
  channels: {
    channelId: string;
    label: string;
    records: number;
    checksum: string;
    readCapability: string;
    resident: { id: string; genome: string; designHash: string | null; health: number } | null;
    studios: { id: string; phase: string; designHash: string | null }[];
  }[];
}

export function summarizeBundle(world: WorldReplay) {
  verifyAcceptedWorld(world);
  return {
    sourceWorldId: world.sourceWorldId,
    channels: world.channels.map((channel) => ({
      channelId: channel.channelId,
      label: channel.label,
      records: channel.records.length,
      checksum: channel.checksum,
      studioRecords: channel.records.filter((record) => record.command.type.startsWith('studio'))
        .length,
      crossChannelRecords: channel.records.filter((record) => record.dependencies.length > 0)
        .length,
    })),
  };
}

/**
 * Rebuilds a world from its accepted records alone, compares it with the source when present,
 * and reports each channel's resident, committed design and studio outcomes. Each replayed
 * channel gets a fresh read capability so the replay can be inspected in the preview.
 */
export async function runReplay(pool: pg.Pool, world: WorldReplay): Promise<ReplayReport> {
  const replayed = await replayAcceptedWorld(pool, world);
  const sourcePresent =
    (await pool.query('select 1 from worlds where id=$1', [world.sourceWorldId])).rowCount === 1;
  const channels: ReplayReport['channels'] = [];
  for (const bundle of world.channels) {
    const readCapability = randomBytes(32).toString('base64url');
    await pool.query(
      'insert into overlay_capabilities(hash,world_id,channel_id) values($1,$2,$3)',
      [sha256Hex(readCapability), replayed.worldId, bundle.channelId],
    );
    const resident = (
      await pool.query<{
        id: string;
        pulse: number;
        calm: number;
        grit: number;
        drift: number;
        appearance_hash: string | null;
        health: number;
      }>(
        `select o.* from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id
        where r.world_id=$1 and r.channel_id=$2 and r.role='resident' order by r.ended_at is null desc,r.started_at desc limit 1`,
        [replayed.worldId, bundle.channelId],
      )
    ).rows[0];
    const studios = (
      await pool.query<{ id: string; phase: string; hash: string | null }>(
        `select s.id,s.phase,p.blueprint_hash as hash from studio_sessions s
        left join pending_adaptations p on p.world_id=s.world_id and p.session_id=s.id and p.status='committed'
        where s.world_id=$1 and s.channel_id=$2 order by s.created_at`,
        [replayed.worldId, bundle.channelId],
      )
    ).rows;
    channels.push({
      channelId: bundle.channelId,
      label: bundle.label,
      records: bundle.records.length,
      checksum: bundle.checksum,
      readCapability,
      resident:
        resident === undefined
          ? null
          : {
              id: resident.id,
              genome: `${resident.pulse}/${resident.calm}/${resident.grit}/${resident.drift}`,
              designHash: resident.appearance_hash,
              health: resident.health,
            },
      studios: studios.map((studio) => ({
        id: studio.id,
        phase: studio.phase,
        designHash: studio.hash,
      })),
    });
  }
  return {
    replayWorldId: replayed.worldId,
    sourceWorldId: world.sourceWorldId,
    sourceComparison: sourcePresent
      ? await compareWorldReplay(pool, world.sourceWorldId, replayed.worldId, replayed.channelIds)
      : null,
    channels,
  };
}
