import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from './signature.ts';
describe('exact-byte EventSub verification', () => {
  const secret = 's'.repeat(64),
    raw = Buffer.from('{ "event": {"name":"é"} }');
  const timestamp = new Date().toISOString(),
    id = 'opaque-receipt';
  const headers = {
    'twitch-eventsub-message-id': id,
    'twitch-eventsub-message-timestamp': timestamp,
    'twitch-eventsub-message-type': 'notification',
    'twitch-eventsub-message-signature': `sha256=${createHmac('sha256', secret)
      .update(id + timestamp)
      .update(raw)
      .digest('hex')}`,
  };
  it('verifies raw Unicode/whitespace bytes and rejects tampering, malformed signatures and stale/future messages', () => {
    expect(verifyWebhook(headers, raw, secret).id).toBe(id);
    expect(() =>
      verifyWebhook(headers, Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), secret),
    ).toThrow('INVALID_SIGNATURE');
    for (const signature of ['sha256=x', 'a'.repeat(1000), 'sha256=' + '0'.repeat(64)])
      expect(() =>
        verifyWebhook({ ...headers, 'twitch-eventsub-message-signature': signature }, raw, secret),
      ).toThrow('INVALID_SIGNATURE');
    expect(() => verifyWebhook(headers, raw, secret, Date.parse(timestamp) + 600001)).toThrow(
      'STALE_NOTIFICATION',
    );
    expect(() => verifyWebhook(headers, raw, secret, Date.parse(timestamp) - 60001)).toThrow(
      'STALE_NOTIFICATION',
    );
  });
});
