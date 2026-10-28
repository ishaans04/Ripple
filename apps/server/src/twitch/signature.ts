import { createHmac, timingSafeEqual } from 'node:crypto';
import { ControlError } from './sessions.ts';
export function verifyWebhook(
  headers: Record<string, string | string[] | undefined>,
  raw: Buffer,
  secret: string,
  now = Date.now(),
): { id: string; timestamp: string; kind: string } {
  const id = headers['twitch-eventsub-message-id'],
    timestamp = headers['twitch-eventsub-message-timestamp'],
    signature = headers['twitch-eventsub-message-signature'],
    kind = headers['twitch-eventsub-message-type'];
  if (
    typeof id !== 'string' ||
    !/^[\x21-\x7e]{1,200}$/.test(id) ||
    typeof timestamp !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(timestamp) ||
    typeof signature !== 'string' ||
    !/^sha256=[0-9a-f]{64}$/.test(signature) ||
    typeof kind !== 'string' ||
    !['notification', 'webhook_callback_verification', 'revocation'].includes(kind)
  )
    throw new ControlError(403, 'INVALID_SIGNATURE');
  const age = now - Date.parse(timestamp);
  if (!Number.isFinite(age) || age > 600000 || age < -60000)
    throw new ControlError(403, 'STALE_NOTIFICATION');
  const expected = createHmac('sha256', secret).update(id).update(timestamp).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex')))
    throw new ControlError(403, 'INVALID_SIGNATURE');
  return { id, timestamp, kind };
}
