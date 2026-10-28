import { randomBytes, randomUUID } from 'node:crypto';
import { transaction } from '@ripple/database';
import { candidateRuleset, rulesetCanonicalJson, rulesetHash, sha256Hex } from '@ripple/engine';
import { liveRoundTimings } from '@ripple/contracts';
import type pg from 'pg';
import type { TwitchConfig } from './security.ts';

/** One durable live world per registered application; a key change requires an explicit migration. */
export async function ensureInstallation(pool: pg.Pool, config: TwitchConfig): Promise<string> {
  return transaction(pool, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `twitch:${config.clientId}`,
    ]);
    const existing = (
      await client.query<{ world_id: string; actor_key_fingerprint: string }>(
        'select world_id,actor_key_fingerprint from twitch_installations where client_id=$1',
        [config.clientId],
      )
    ).rows[0];
    const fingerprint = sha256Hex(config.actorKey);
    if (existing !== undefined) {
      if (existing.actor_key_fingerprint !== fingerprint)
        throw new Error(
          'ACTOR_HASH_KEY changed: migrate identity scopes before restarting live intake',
        );
      return existing.world_id;
    }
    const hash = rulesetHash(candidateRuleset),
      worldId = randomUUID();
    await client.query(
      'insert into rulesets (hash,version,engine_version,canonical) values ($1,$2,$3,$4) on conflict do nothing',
      [
        hash,
        candidateRuleset.version,
        candidateRuleset.engineVersion,
        rulesetCanonicalJson(candidateRuleset),
      ],
    );
    await client.query("insert into worlds (id,mode,rules_hash) values ($1,'live',$2)", [
      worldId,
      hash,
    ]);
    await client.query(
      'insert into twitch_installations (client_id,world_id,actor_key_fingerprint) values ($1,$2,$3)',
      [config.clientId, worldId, fingerprint],
    );
    return worldId;
  });
}
export async function enrollChannel(
  client: pg.PoolClient,
  worldId: string,
  twitchId: string,
  login: string,
): Promise<string> {
  const channelId = randomUUID();
  const row = (
    await client.query<{ id: string }>(
      `insert into channels (world_id,id,twitch_id,label,rules_hash,seed,configuration)
    select id,$2,$3,$4,rules_hash,$5,$6 from worlds where id=$1 and mode='live'
    on conflict (world_id,twitch_id) do update set label=excluded.label returning id`,
      [
        worldId,
        channelId,
        twitchId,
        login,
        randomBytes(16).toString('hex'),
        JSON.stringify(liveRoundTimings),
      ],
    )
  ).rows[0];
  if (row === undefined) throw new Error('Live installation not found');
  await client.query(
    'insert into twitch_channels (world_id,channel_id) values ($1,$2) on conflict do nothing',
    [worldId, row.id],
  );
  return row.id;
}
