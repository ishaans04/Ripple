import { createHash, randomBytes } from 'node:crypto';
import { transaction } from '@ripple/database';
import type pg from 'pg';

const tokenPattern = /artist:[0-9a-f]{32}/g;
export async function registerArtistIdentity(
  pool: pg.Pool,
  worldId: string,
  subjectHash: string,
  login: string,
) {
  return transaction(pool, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `artist:${worldId}:${subjectHash}`,
    ]);
    await client.query(
      'delete from artist_identities where world_id=$1 and subject_hash=$2 and expires_at<=clock_timestamp()',
      [worldId, subjectHash],
    );
    const result = await client.query<{ artist_key: string; credit_token: string }>(
      `insert into artist_identities(world_id,subject_hash,artist_key,credit_token,login,expires_at)
       values($1,$2,$3,$4,$5,clock_timestamp()+interval '30 days')
       on conflict(world_id,subject_hash) do update set login=excluded.login,expires_at=excluded.expires_at
       returning artist_key,credit_token`,
      [
        worldId,
        subjectHash,
        // The input is already an installation-secret account HMAC, never a raw Twitch ID.
        // Keep proposal uniqueness and moderation stable across forgetting/re-authentication.
        createHash('sha256')
          .update(`ripple-artist:${worldId.toLowerCase()}:${subjectHash}`)
          .digest('hex'),
        `artist:${randomBytes(16).toString('hex')}`,
        login.slice(0, 40),
      ],
    );
    const identity = result.rows[0];
    if (!identity) throw new Error('Artist identity was not saved.');
    return identity;
  });
}

/** Resolve only at the presentation boundary, never in accepted records or stored projections. */
export async function resolvePublicCredits<T>(pool: pg.Pool, value: T): Promise<T> {
  const json = JSON.stringify(value);
  const tokens = [...new Set(json.match(tokenPattern) ?? [])];
  if (tokens.length === 0) return value;
  const rows = await pool.query<{ credit_token: string; login: string }>(
    'select credit_token,login from artist_identities where credit_token=any($1::text[]) and expires_at>clock_timestamp()',
    [tokens],
  );
  const names = new Map(rows.rows.map((row) => [row.credit_token, row.login]));
  const replace = (item: unknown): unknown => {
    if (typeof item === 'string')
      return item.replace(tokenPattern, (token) => names.get(token) ?? 'Former artist');
    if (Array.isArray(item)) return item.map(replace);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, replace(child)]));
    return item;
  };
  return replace(value) as T;
}

export async function forgetArtist(pool: pg.Pool, worldId: string, artistKey: string) {
  return transaction(pool, async (client) => {
    await client.query(
      'insert into privacy_erasures(world_id,artist_key) values($1,$2) on conflict do nothing',
      [worldId, artistKey],
    );
    const sessions = await client.query(
      'delete from artist_sessions where world_id=$1 and artist_key=$2',
      [worldId, artistKey],
    );
    const identity = await client.query(
      'delete from artist_identities where world_id=$1 and artist_key=$2',
      [worldId, artistKey],
    );
    return { identitiesDeleted: identity.rowCount ?? 0, sessionsDeleted: sessions.rowCount ?? 0 };
  });
}
