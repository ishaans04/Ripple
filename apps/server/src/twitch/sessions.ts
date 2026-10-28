import type pg from 'pg';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ErrorCode } from '@ripple/contracts';
import { equalSecret, opaqueToken, privateHash, type TwitchConfig } from './security.ts';

export class ControlError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  constructor(status: number, code: ErrorCode) {
    super(code);
    this.status = status;
    this.code = code;
    this.name = 'ControlError';
  }
}
export function cookie(request: FastifyRequest, name: string): string | undefined {
  const parts = (request.headers.cookie ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${name}=`));
  if (parts.length !== 1) return undefined;
  const value = parts[0]?.slice(name.length + 1);
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
export function setCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  lifetime: number,
  httpOnly = true,
): string {
  const encoded = `${name}=${value}; Path=/; Secure; SameSite=Lax; Max-Age=${lifetime}${httpOnly ? '; HttpOnly' : ''}`;
  // Fastify appends set-cookie headers itself; re-supplying prior values duplicates them.
  reply.header('set-cookie', encoded);
  return value;
}
export function requireOrigin(request: FastifyRequest, origin: string): void {
  if (request.headers.origin !== origin) throw new ControlError(403, 'CSRF_FAILED');
}
export interface OwnerSession {
  world_id: string;
  channel_id: string;
  subject: string;
  csrf_hash: string;
}
export async function ownerSession(
  pool: pg.Pool,
  request: FastifyRequest,
  config: TwitchConfig,
  write = false,
): Promise<OwnerSession> {
  const raw = cookie(request, '__Host-ripple-session');
  if (raw === undefined) throw new ControlError(401, 'SIGN_IN_REQUIRED');
  const row = (
    await pool.query<OwnerSession>(
      `select s.world_id,s.channel_id,s.subject,s.csrf_hash from controller_sessions s
    join oauth_grants g on g.world_id=s.world_id and g.channel_id=s.channel_id and g.subject=s.subject and g.purpose='broadcaster'
    where s.hash=$1 and s.expires_at>clock_timestamp() and g.revoked_at is null and g.validated_at>clock_timestamp()-interval '1 hour'`,
      [privateHash(config.sessionSecret, 'session', raw)],
    )
  ).rows[0];
  if (row === undefined) throw new ControlError(401, 'SIGN_IN_REQUIRED');
  if (write) {
    requireOrigin(request, config.origin);
    const csrf = request.headers['x-csrf-token'];
    if (
      typeof csrf !== 'string' ||
      !equalSecret(privateHash(config.sessionSecret, 'csrf', csrf), row.csrf_hash)
    )
      throw new ControlError(403, 'CSRF_FAILED');
  }
  return row;
}
export async function createOwnerSession(
  client: pg.PoolClient,
  reply: FastifyReply,
  world: string,
  channel: string,
  subject: string,
  secret: string,
): Promise<void> {
  const session = opaqueToken(),
    csrf = opaqueToken();
  await client.query(
    "insert into controller_sessions (hash,world_id,channel_id,subject,csrf_hash,expires_at) values ($1,$2,$3,$4,$5,clock_timestamp()+interval '12 hours')",
    [
      privateHash(secret, 'session', session),
      world,
      channel,
      subject,
      privateHash(secret, 'csrf', csrf),
    ],
  );
  setCookie(reply, '__Host-ripple-session', session, 43200);
  setCookie(reply, '__Host-ripple-csrf', csrf, 43200, false);
}
