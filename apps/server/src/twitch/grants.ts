import { randomUUID } from 'node:crypto';
import { transaction, acceptInputInTransaction } from '@ripple/database';
import type pg from 'pg';
import {
  type TwitchClient,
  TwitchError,
  type ProviderTokens,
  type ValidatedToken,
} from './client.ts';
import { decryptTokens, encryptTokens, type TwitchConfig } from './security.ts';

export const requiredScopes = {
  broadcaster: ['channel:bot'],
  bot: ['user:read:chat', 'user:write:chat', 'user:bot'],
} as const;
export type GrantPurpose = keyof typeof requiredScopes;
export interface GrantRow {
  world_id: string;
  channel_id: string | null;
  subject: string;
  purpose: GrantPurpose;
  encrypted_tokens: unknown;
  expires_at: Date;
  validated_at: Date | null;
  revoked_at: Date | null;
}
export function grantContext(worldId: string, purpose: GrantPurpose, subject: string): string {
  return JSON.stringify([worldId, purpose, subject]);
}
export function checkIdentity(
  identity: ValidatedToken,
  config: TwitchConfig,
  purpose: GrantPurpose,
  subject?: string,
): void {
  if (
    identity.client_id !== config.clientId ||
    identity.user_id === undefined ||
    (subject !== undefined && identity.user_id !== subject) ||
    !requiredScopes[purpose].every((s) => identity.scopes.includes(s))
  )
    throw new TwitchError(401, 'GRANT_REVOKED');
}
export async function storeGrant(
  client: pg.PoolClient,
  config: TwitchConfig,
  worldId: string,
  channelId: string | null,
  purpose: GrantPurpose,
  tokens: ProviderTokens,
  identity: ValidatedToken,
): Promise<void> {
  checkIdentity(identity, config, purpose);
  if (tokens.refresh_token === undefined || identity.user_id === undefined)
    throw new TwitchError(401, 'GRANT_REVOKED');
  // Replacing the operator bot deliberately ends the previous bot identity.
  if (purpose === 'bot')
    await client.query(
      "delete from oauth_grants where world_id=$1 and purpose='bot' and subject<>$2",
      [worldId, identity.user_id],
    );
  await client.query(
    `insert into oauth_grants (world_id,channel_id,subject,purpose,scopes,encrypted_tokens,expires_at,validated_at) values ($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 second',clock_timestamp())
    on conflict (world_id,purpose,subject) do update set channel_id=excluded.channel_id,scopes=excluded.scopes,encrypted_tokens=excluded.encrypted_tokens,expires_at=excluded.expires_at,validated_at=excluded.validated_at,revoked_at=null,refresh_owner=null,refresh_until=null`,
    [
      worldId,
      channelId,
      identity.user_id,
      purpose,
      identity.scopes,
      JSON.stringify(
        encryptTokens(
          { access: tokens.access_token, refresh: tokens.refresh_token },
          config.encryptionKey,
          grantContext(worldId, purpose, identity.user_id),
        ),
      ),
      identity.expires_in,
    ],
  );
}
export async function revokeGrant(pool: pg.Pool, grant: GrantRow, owner?: string): Promise<void> {
  await transaction(pool, async (client) => {
    // Lock channels before grants, matching every gameplay writer's ordering.
    const channels = await client.query<{ id: string }>(
      `select c.id from channels c where world_id=$1 and ($2::uuid is null or id=$2) order by id for update`,
      [grant.world_id, grant.channel_id],
    );
    const revoked = await client.query(
      'update oauth_grants set revoked_at=clock_timestamp(),refresh_owner=null,refresh_until=null where world_id=$1 and purpose=$2 and subject=$3 and ($4::uuid is null or refresh_owner=$4)',
      [grant.world_id, grant.purpose, grant.subject, owner ?? null],
    );
    if (revoked.rowCount !== 1) return;
    if (grant.channel_id !== null)
      await client.query('delete from controller_sessions where world_id=$1 and channel_id=$2', [
        grant.world_id,
        grant.channel_id,
      ]);
    for (const channel of channels.rows) {
      await client.query(
        "update twitch_channels set input_error='GRANT_REVOKED' where world_id=$1 and channel_id=$2",
        [grant.world_id, channel.id],
      );
      await acceptInputInTransaction(client, {
        worldId: grant.world_id,
        channelId: channel.id,
        provider: 'twitch-health',
        messageId: randomUUID(),
        command: { type: 'interrupt', reason: 'input_outage' },
        requiredMode: 'live',
      });
    }
  });
}
/** Lease covers only this grant, never a game/channel lock while the network is awaited. */
export async function maintainGrant(
  pool: pg.Pool,
  api: TwitchClient,
  grant: GrantRow,
  force = false,
): Promise<boolean> {
  if (grant.revoked_at !== null) return false;
  const owner = randomUUID();
  const claimed = await pool.query<GrantRow>(
    `update oauth_grants set refresh_owner=$4,refresh_until=clock_timestamp()+interval '30 seconds'
    where world_id=$1 and purpose=$2 and subject=$3 and revoked_at is null and (refresh_until is null or refresh_until<clock_timestamp())
    and ($5 or validated_at is null or validated_at<clock_timestamp()-interval '1 hour' or expires_at<=clock_timestamp()) returning *`,
    [grant.world_id, grant.purpose, grant.subject, owner, force],
  );
  const current = claimed.rows[0];
  if (current === undefined) return false;
  try {
    let tokens = decryptTokens(
      current.encrypted_tokens,
      api.config.encryptionKey,
      grantContext(grant.world_id, grant.purpose, grant.subject),
    );
    let identity: ValidatedToken;
    try {
      identity = await api.validate(tokens.access);
    } catch (error) {
      if (!(error instanceof TwitchError) || error.status !== 401) throw error;
      // A prematurely invalid token represents revoked authorization, not routine expiry.
      if (current.expires_at.getTime() > Date.now() + 5000) throw error;
      let fresh: ProviderTokens;
      try {
        fresh = await api.tokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh });
      } catch (refreshError) {
        if (
          refreshError instanceof TwitchError &&
          (refreshError.status === 400 || refreshError.status === 401)
        )
          throw new TwitchError(401, 'GRANT_REVOKED');
        throw refreshError;
      }
      if (fresh.refresh_token === undefined) throw new TwitchError(502, 'INVALID_RESPONSE');
      tokens = { access: fresh.access_token, refresh: fresh.refresh_token };
      identity = await api.validate(tokens.access);
    }
    checkIdentity(identity, api.config, grant.purpose, grant.subject);
    const saved = await pool.query(
      `update oauth_grants set encrypted_tokens=$5,scopes=$6,expires_at=clock_timestamp()+$7*interval '1 second',validated_at=clock_timestamp(),refresh_owner=null,refresh_until=null
      where world_id=$1 and purpose=$2 and subject=$3 and refresh_owner=$4 and refresh_until>clock_timestamp() and revoked_at is null`,
      [
        grant.world_id,
        grant.purpose,
        grant.subject,
        owner,
        JSON.stringify(
          encryptTokens(
            tokens,
            api.config.encryptionKey,
            grantContext(grant.world_id, grant.purpose, grant.subject),
          ),
        ),
        identity.scopes,
        identity.expires_in,
      ],
    );
    return saved.rowCount === 1;
  } catch (error) {
    await pool.query(
      'update oauth_grants set validated_at=null where world_id=$1 and purpose=$2 and subject=$3 and refresh_owner=$4',
      [grant.world_id, grant.purpose, grant.subject, owner],
    );
    if (error instanceof TwitchError && error.code === 'GRANT_REVOKED') {
      // A concurrent fresh sign-in supersedes this old validation attempt.
      await revokeGrant(pool, grant, owner);
    }
    throw error;
  } finally {
    await pool.query(
      'update oauth_grants set refresh_owner=null,refresh_until=null where world_id=$1 and purpose=$2 and subject=$3 and refresh_owner=$4',
      [grant.world_id, grant.purpose, grant.subject, owner],
    );
  }
}
