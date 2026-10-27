import { randomUUID } from 'node:crypto';
import {
  gameCommandSchema,
  roundTimingsSchema,
  type GameCommand,
  type RoundTimings,
} from '@ripple/contracts';
import { acceptInput, transaction } from '@ripple/database';
import {
  assertCompatibleRuleset,
  canonicalJson,
  parseRuleset,
  rulesetHash,
  sha256Hex,
} from '@ripple/engine';
import { z } from 'zod';
import type pg from 'pg';
import { processNextInput } from './worker.ts';
import type { CommandEffect } from './lifecycle.ts';
import type { WorldScope } from './sandbox.ts';

export interface AcceptedRecord {
  engineVersion: number;
  rulesHash: string;
  sequence: number;
  operationId: string;
  acceptedAtMs: number;
  command: GameCommand;
  result: CommandEffect;
  dependencies: readonly unknown[];
  previousChecksum: string;
  checksum: string;
  provider: string;
  messageId: string;
}
export interface ChannelReplay {
  schemaVersion: 1;
  channelId: string;
  label: string;
  seed: string;
  timings: RoundTimings;
  rulesCanonical: string;
  rulesHash: string;
  initialOnline: boolean;
  initialHealthy: boolean;
  initialPaused: boolean;
  checksum: string;
  records: readonly AcceptedRecord[];
}
export class ReplayIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayIntegrityError';
  }
}
export function verifyAcceptedRecords(bundle: ChannelReplay): void {
  z.literal(1).parse(bundle.schemaVersion);
  const rules = parseRuleset(JSON.parse(bundle.rulesCanonical));
  assertCompatibleRuleset(rules);
  if (rulesetHash(rules) !== bundle.rulesHash)
    throw new ReplayIntegrityError('Rules hash mismatch.');
  roundTimingsSchema.parse(bundle.timings);
  let previous = '0'.repeat(64),
    sequence = 0;
  for (const record of bundle.records) {
    sequence++;
    if (record.sequence !== sequence || record.previousChecksum !== previous)
      throw new ReplayIntegrityError(`History gap at sequence ${sequence}.`);
    if (record.rulesHash !== bundle.rulesHash || record.engineVersion !== rules.engineVersion)
      throw new ReplayIntegrityError(`Incompatible context at sequence ${sequence}.`);
    gameCommandSchema.parse(record.command);
    if (record.operationId !== `${record.provider}:${record.messageId}`)
      throw new ReplayIntegrityError('Receipt identity mismatch.');
    const material = {
      previousChecksum: previous,
      engineVersion: record.engineVersion,
      rulesHash: record.rulesHash,
      sequence: record.sequence,
      operationId: record.operationId,
      acceptedAtMs: record.acceptedAtMs,
      command: record.command,
      result: record.result,
      dependencies: record.dependencies,
    };
    const checksum = sha256Hex(canonicalJson(material));
    if (checksum !== record.checksum)
      throw new ReplayIntegrityError(`Checksum mismatch at sequence ${sequence}.`);
    previous = checksum;
  }
  if (previous !== bundle.checksum)
    throw new ReplayIntegrityError('Final channel checksum mismatch.');
}
export async function exportAcceptedChannel(
  pool: pg.Pool,
  scope: WorldScope,
): Promise<ChannelReplay> {
  return transaction(pool, async (client) => {
    await client.query('set transaction isolation level repeatable read read only');
    const row = (
      await client.query<{
        label: string;
        seed: string;
        configuration: unknown;
        rules_hash: string;
        canonical: string;
        initial_online: boolean;
        initial_healthy: boolean;
        initial_paused: boolean;
        checksum: string;
        processed_sequence: number;
      }>(
        'select c.*,r.canonical from channels c join rulesets r on r.hash=c.rules_hash where c.world_id=$1 and c.id=$2',
        [scope.worldId, scope.channelId],
      )
    ).rows[0];
    if (row === undefined) throw new ReplayIntegrityError('Channel is missing.');
    const events = await client.query<{
      engine_version: number;
      rules_hash: string;
      sequence: number;
      operation_id: string;
      accepted_at: Date;
      command: GameCommand;
      result: CommandEffect;
      dependencies: unknown[];
      previous_checksum: string;
      checksum: string;
      provider: string;
      message_id: string;
    }>(
      `select e.*,i.provider,i.message_id from game_events e join inbox i on i.world_id=e.world_id and i.channel_id=e.channel_id and i.sequence=e.sequence where e.world_id=$1 and e.channel_id=$2 and e.sequence<=$3 order by e.sequence`,
      [scope.worldId, scope.channelId, row.processed_sequence],
    );
    const bundle: ChannelReplay = {
      schemaVersion: 1,
      channelId: scope.channelId,
      label: row.label,
      seed: row.seed,
      timings: roundTimingsSchema.parse(row.configuration),
      rulesCanonical: row.canonical,
      rulesHash: row.rules_hash,
      initialOnline: row.initial_online,
      initialHealthy: row.initial_healthy,
      initialPaused: row.initial_paused,
      checksum: row.checksum,
      records: events.rows.map((e) => ({
        engineVersion: e.engine_version,
        rulesHash: e.rules_hash,
        sequence: e.sequence,
        operationId: e.operation_id,
        acceptedAtMs: e.accepted_at.getTime(),
        command: e.command,
        result: e.result,
        dependencies: e.dependencies,
        previousChecksum: e.previous_checksum,
        checksum: e.checksum,
        provider: e.provider,
        messageId: e.message_id,
      })),
    };
    verifyAcceptedRecords(bundle);
    return bundle;
  });
}
/** Reconstruction reads accepted records, never original activity tables or clocks. */
export async function replayAcceptedChannel(
  pool: pg.Pool,
  bundle: ChannelReplay,
): Promise<WorldScope> {
  verifyAcceptedRecords(bundle);
  if (bundle.records.some((record) => record.dependencies.length !== 0))
    throw new ReplayIntegrityError('Cross-channel records require dependency-ordered replay.');
  const worldId = randomUUID(),
    channelId = bundle.channelId;
  await transaction(pool, async (client) => {
    await client.query(
      `insert into worlds (id,mode,rules_hash,expires_at) values ($1,'replay',$2,clock_timestamp()+interval '1 day')`,
      [worldId, bundle.rulesHash],
    );
    await client.query(
      `insert into channels (world_id,id,label,rules_hash,seed,configuration,online,healthy,paused,initial_online,initial_healthy,initial_paused)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$8,$9)`,
      [
        worldId,
        channelId,
        bundle.label,
        bundle.rulesHash,
        bundle.seed,
        JSON.stringify(bundle.timings),
        bundle.initialOnline,
        bundle.initialHealthy,
        bundle.initialPaused,
      ],
    );
  });
  for (const record of bundle.records) {
    await acceptInput(pool, {
      worldId,
      channelId,
      provider: record.provider,
      messageId: record.messageId,
      command: record.command,
      acceptedAtMs: record.acceptedAtMs,
      requiredMode: 'replay',
    });
    const result = await processNextInput(pool, worldId, channelId);
    if (result?.checksum !== record.checksum)
      throw new ReplayIntegrityError(`Replayed transition differs at sequence ${record.sequence}.`);
  }
  return { worldId, channelId };
}
/** Canonical gameplay equality excludes outbox delivery, worker leases and world identity. */
export async function canonicalGameProjection(pool: pg.Pool, scope: WorldScope): Promise<string> {
  const row = (
    await pool.query<{ projection: unknown }>(
      `select jsonb_build_object(
    'channel',(select jsonb_build_object('online',online,'healthy',healthy,'paused',paused,'version',state_version,'checksum',checksum) from channels where world_id=$1 and id=$2),
    'organisms',coalesce((select jsonb_agg(to_jsonb(o)-'world_id'-'created_at' order by o.id) from organisms o where o.world_id=$1 and exists(select 1 from residencies r where r.world_id=o.world_id and r.organism_id=o.id and r.channel_id=$2)),'[]'::jsonb),
    'rounds',coalesce((select jsonb_agg(to_jsonb(r)-'world_id' order by r.number) from rounds r where r.world_id=$1 and r.channel_id=$2),'[]'::jsonb),
    'residencies',coalesce((select jsonb_agg(to_jsonb(r)-'world_id' order by r.id) from residencies r where r.world_id=$1 and r.channel_id=$2),'[]'::jsonb),
    'baselines',coalesce((select jsonb_agg(to_jsonb(b)-'world_id' order by b.round_id) from habitat_baselines b where b.world_id=$1 and b.channel_id=$2),'[]'::jsonb)
    ) as projection`,
      [scope.worldId, scope.channelId],
    )
  ).rows[0];
  if (row === undefined) throw new ReplayIntegrityError('Missing game projection.');
  return canonicalJson(row.projection);
}
