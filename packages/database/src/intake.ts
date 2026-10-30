import type pg from 'pg';
import { lockChannels, transaction } from './transaction.ts';

export class IntakeError extends Error {
  readonly code: 'NOT_FOUND' | 'WORLD_EXPIRED' | 'WRONG_WORLD_MODE' | 'RECEIPT_CONFLICT';
  constructor(code: IntakeError['code']) {
    super(code);
    this.name = 'IntakeError';
    this.code = code;
  }
}
export interface IntakeInput {
  readonly worldId: string;
  readonly channelId: string;
  readonly provider: string;
  readonly messageId: string;
  readonly command: unknown;
  readonly requiredMode?: 'live' | 'sandbox' | 'replay';
  /** Trusted synthetic/replay adapter only. Rejected against live worlds. */
  readonly acceptedAtMs?: number;
}
export interface IntakeReceipt {
  readonly sequence: number;
  readonly duplicate: boolean;
  readonly acceptedAtMs: number;
}

export async function acceptInputInTransaction(
  client: pg.PoolClient,
  input: IntakeInput,
): Promise<IntakeReceipt> {
  await lockChannels(client, input.worldId, [input.channelId]);
  const scope = await client.query<{ mode: string; expired: boolean }>(
    'select mode, expires_at is not null and expires_at <= clock_timestamp() as expired from worlds where id=$1',
    [input.worldId],
  );
  const world = scope.rows[0];
  if (world === undefined) throw new IntakeError('NOT_FOUND');
  if (world.expired) throw new IntakeError('WORLD_EXPIRED');
  if (
    (input.requiredMode !== undefined && world.mode !== input.requiredMode) ||
    (input.acceptedAtMs !== undefined && world.mode === 'live')
  )
    throw new IntakeError('WRONG_WORLD_MODE');
  const previous = await client.query<{
    channel_id: string;
    sequence: number;
    accepted_at: Date;
    same_command: boolean;
  }>(
    `select channel_id,sequence,accepted_at,command_hash=encode(sha256(convert_to($4::jsonb::text,'UTF8')),'hex') as same_command
     from input_receipts where world_id=$1 and provider=$2 and message_id=$3`,
    [input.worldId, input.provider, input.messageId, JSON.stringify(input.command)],
  );
  const existing = previous.rows[0];
  if (existing !== undefined) {
    if (existing.channel_id !== input.channelId || !existing.same_command)
      throw new IntakeError('RECEIPT_CONFLICT');
    return {
      sequence: existing.sequence,
      duplicate: true,
      acceptedAtMs: existing.accepted_at.getTime(),
    };
  }
  const cursor = await client.query<{ intake_sequence: number; accepted_at: Date }>(
    `select intake_sequence, greatest(coalesce($3::timestamptz, date_trunc('milliseconds',clock_timestamp())), last_accepted_at) as accepted_at
     from channels where world_id=$1 and id=$2`,
    [
      input.worldId,
      input.channelId,
      input.acceptedAtMs === undefined ? null : new Date(input.acceptedAtMs),
    ],
  );
  const row = cursor.rows[0];
  if (row === undefined) throw new IntakeError('NOT_FOUND');
  const sequence = row.intake_sequence + 1;
  // A provider ID is world-wide. Concurrent receipts targeting different channels
  // may conflict here; the loser rolls back and cannot acknowledge new gameplay.
  const inserted = await client.query(
    `with receipt as (
       insert into input_receipts(world_id,channel_id,sequence,provider,message_id,command_hash,accepted_at)
       values($1,$2,$3,$4,$5,encode(sha256(convert_to($6::jsonb::text,'UTF8')),'hex'),$7)
       on conflict do nothing returning world_id,channel_id,sequence,provider,message_id,accepted_at
     ), payload as (
       insert into inbox(world_id,channel_id,sequence,provider,message_id,command,accepted_at)
       select world_id,channel_id,sequence,provider,message_id,$6::jsonb,accepted_at from receipt
       returning world_id,channel_id,sequence,accepted_at
     )
     update channels c set intake_sequence=p.sequence,last_accepted_at=p.accepted_at
     from payload p where c.world_id=p.world_id and c.id=p.channel_id`,
    [
      input.worldId,
      input.channelId,
      sequence,
      input.provider,
      input.messageId,
      JSON.stringify(input.command),
      row.accepted_at,
    ],
  );
  if (inserted.rowCount !== 1) throw new IntakeError('RECEIPT_CONFLICT');
  return { sequence, duplicate: false, acceptedAtMs: row.accepted_at.getTime() };
}
export async function acceptInput(pool: pg.Pool, input: IntakeInput): Promise<IntakeReceipt> {
  return transaction(pool, (client) => acceptInputInTransaction(client, input));
}
