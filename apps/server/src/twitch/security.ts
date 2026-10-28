import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';

const key = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);
const httpsOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  );
});
const liveEnvironment = z.object({
  PUBLIC_BASE_URL: httpsOrigin,
  TWITCH_CLIENT_ID: z.string().regex(/^[A-Za-z0-9]{10,100}$/),
  TWITCH_CLIENT_SECRET: z.string().min(10).max(256),
  TWITCH_EVENTSUB_SECRET: z.string().regex(/^[\x21-\x7e]{32,100}$/),
  TOKEN_ENCRYPTION_KEY: key,
  ACTOR_HASH_KEY: key,
  OPERATOR_SECRET: z.string().min(32).max(256),
});
export interface TwitchConfig {
  origin: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  encryptionKey: string;
  actorKey: string;
  operatorSecret: string;
}
export function readTwitchConfig(
  env: Record<string, string | undefined>,
): TwitchConfig | undefined {
  if (env.ENABLE_LIVE_TWITCH !== 'true') {
    if (
      env.ENABLE_LIVE_TWITCH !== undefined &&
      env.ENABLE_LIVE_TWITCH !== '' &&
      env.ENABLE_LIVE_TWITCH !== 'false'
    )
      throw new Error('ENABLE_LIVE_TWITCH must be true or false');
    return undefined;
  }
  const parsed = liveEnvironment.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid live configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  const p = parsed.data;
  if (p.TOKEN_ENCRYPTION_KEY === p.ACTOR_HASH_KEY)
    throw new Error('TOKEN_ENCRYPTION_KEY and ACTOR_HASH_KEY must differ');
  return {
    origin: new URL(p.PUBLIC_BASE_URL).origin,
    clientId: p.TWITCH_CLIENT_ID,
    clientSecret: p.TWITCH_CLIENT_SECRET,
    webhookSecret: p.TWITCH_EVENTSUB_SECRET,
    encryptionKey: p.TOKEN_ENCRYPTION_KEY,
    actorKey: p.ACTOR_HASH_KEY,
    operatorSecret: p.OPERATOR_SECRET,
  };
}
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});
export function encryptTokens(
  value: { access: string; refresh: string },
  secret: string,
  context: string,
): unknown {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'base64'), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
export function decryptTokens(
  value: unknown,
  secret: string,
  context: string,
): { access: string; refresh: string } {
  const e = envelopeSchema.parse(value);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(secret, 'base64'),
    Buffer.from(e.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(e.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return z
    .strictObject({ access: z.string().min(1), refresh: z.string().min(1) })
    .parse(JSON.parse(plain.toString('utf8')) as unknown);
}
export function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}
export function privateHash(secret: string, ...scope: string[]): string {
  return createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(JSON.stringify(scope))
    .digest('hex');
}
export function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
