import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  gameCommandSchema,
  roundTimingsSchema,
  type GameCommand,
  type RoundTimings,
} from '@ripple/contracts';
import { acceptInputInTransaction, lockChannels, transaction } from '@ripple/database';
import { candidateRuleset, rulesetCanonicalJson, rulesetHash, sha256Hex } from '@ripple/engine';
import type pg from 'pg';

export interface WorldScope {
  worldId: string;
  channelId: string;
}
export interface SyntheticWorld extends WorldScope {
  ownerCapability: string;
  readCapability: string;
}
export const syntheticTimings: RoundTimings = Object.freeze({
  voteMs: 3000,
  graceMs: 200,
  observationMs: 12_000,
  revealMs: 800,
});
export class SandboxError extends Error {
  readonly code: 'UNAUTHORIZED' | 'WRONG_WORLD_MODE' | 'WORLD_EXPIRED' | 'CAPACITY_FULL';
  constructor(code: SandboxError['code']) {
    super(code);
    this.name = 'SandboxError';
    this.code = code;
  }
}
export function capabilityMatches(capability: string, hash: string): boolean {
  const candidate = Buffer.from(sha256Hex(capability), 'hex');
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && timingSafeEqual(candidate, expected);
}
/** Internal versioned fixture factory; public CLI creation explicitly chooses the current genesis. */
export async function createSyntheticWorld(
  pool: pg.Pool,
  options: { seed?: string; timings?: RoundTimings; mechanicsVersion?: 0 | 1 } = {},
): Promise<SyntheticWorld> {
  const worldId = randomUUID(),
    channelId = randomUUID();
  const ownerCapability = randomBytes(32).toString('base64url'),
    readCapability = randomBytes(32).toString('base64url');
  const rules = candidateRuleset,
    hash = rulesetHash(rules);
  const timings = roundTimingsSchema.parse(options.timings ?? syntheticTimings);
  await transaction(pool, async (client) => {
    await client.query(
      'insert into rulesets (hash,version,engine_version,canonical) values ($1,$2,$3,$4) on conflict do nothing',
      [hash, rules.version, rules.engineVersion, rulesetCanonicalJson(rules)],
    );
    await client.query(
      `insert into worlds (id,mode,owner_capability_hash,rules_hash,expires_at,clock_at) values ($1,'sandbox',$2,$3,clock_timestamp()+interval '1 day',date_trunc('milliseconds',clock_timestamp()))`,
      [worldId, sha256Hex(ownerCapability), hash],
    );
    await client.query(
      `insert into channels (world_id,id,label,rules_hash,seed,configuration,online,healthy,initial_online,initial_healthy,initial_mechanics_version) values ($1,$2,'Synthetic channel',$3,$4,$5,true,true,true,true,$6)`,
      [
        worldId,
        channelId,
        hash,
        options.seed ?? randomBytes(16).toString('hex'),
        JSON.stringify(timings),
        options.mechanicsVersion ?? 0,
      ],
    );
    await client.query(
      'insert into overlay_capabilities (hash,world_id,channel_id) values ($1,$2,$3)',
      [sha256Hex(readCapability), worldId, channelId],
    );
  });
  return { worldId, channelId, ownerCapability, readCapability };
}
export async function authorizeSynthetic(
  client: pg.PoolClient,
  scope: WorldScope,
  owner: string,
): Promise<Date> {
  await lockChannels(client, scope.worldId, [scope.channelId]);
  const row = (
    await client.query<{
      mode: string;
      owner_capability_hash: string | null;
      expired: boolean;
      clock_at: Date;
    }>(
      'select mode,owner_capability_hash,clock_at,expires_at<=clock_timestamp() as expired from worlds where id=$1 for update',
      [scope.worldId],
    )
  ).rows[0];
  if (
    row === undefined ||
    row.owner_capability_hash === null ||
    !capabilityMatches(owner, row.owner_capability_hash)
  )
    throw new SandboxError('UNAUTHORIZED');
  if (row.mode !== 'sandbox') throw new SandboxError('WRONG_WORLD_MODE');
  if (row.expired) throw new SandboxError('WORLD_EXPIRED');
  return row.clock_at;
}
export async function acceptSyntheticCommand(
  pool: pg.Pool,
  scope: WorldScope,
  owner: string,
  messageId: string,
  value: unknown,
): Promise<{ sequence: number; duplicate: boolean; acceptedAtMs: number }> {
  const command: GameCommand = gameCommandSchema.parse(value);
  // Only the scheduler creates authoritative cutoff markers.
  if (command.type === 'deadline') throw new Error('Use the synthetic clock to close rounds.');
  return transaction(pool, async (client) => {
    const at = await authorizeSynthetic(client, scope, owner);
    return acceptInputInTransaction(client, {
      ...scope,
      provider: 'synthetic',
      messageId,
      command,
      requiredMode: 'sandbox',
      acceptedAtMs: at.getTime(),
    });
  });
}
export function syntheticSeedCommand(): Extract<GameCommand, { type: 'seed' }> {
  return {
    type: 'seed',
    organismId: randomUUID(),
    lineageId: randomUUID(),
    residencyId: randomUUID(),
    roundId: randomUUID(),
  };
}
