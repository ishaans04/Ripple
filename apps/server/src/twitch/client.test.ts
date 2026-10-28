import { describe, expect, it } from 'vitest';
import { TwitchClient } from './client.ts';
import type { TwitchConfig } from './security.ts';
const config: TwitchConfig = {
  origin: 'https://example.com',
  clientId: 'client',
  clientSecret: 'secret',
  webhookSecret: 'webhook',
  encryptionKey: '',
  actorKey: '',
  operatorSecret: '',
  sessionSecret: Buffer.alloc(32, 19).toString('base64'),
};
describe('Twitch transport', () => {
  it('serializes app-token acquisition and renews once after 401', async () => {
    let grants = 0,
      reads = 0;
    const client = new TwitchClient(config, async (url, init) => {
      await Promise.resolve();
      if (url.includes('/oauth2/token')) {
        grants++;
        expect(
          typeof init.body === 'string' || init.body instanceof URLSearchParams
            ? init.body.toString()
            : '',
        ).toContain('grant_type=client_credentials');
        return Response.json({ access_token: `token${grants}`, expires_in: 3600 });
      }
      reads++;
      return reads === 1
        ? new Response('private provider body', { status: 401 })
        : Response.json({ data: [] });
    });
    await Promise.all([client.appToken(), client.appToken()]);
    expect(grants).toBe(1);
    await expect(client.helix('/streams?user_id=1')).resolves.toEqual({ data: [] });
    expect(grants).toBe(2);
    expect(reads).toBe(2);
  });
  it('encodes refresh tokens and keeps failure bodies private', async () => {
    const client = new TwitchClient(config, async (_url, init) => {
      await Promise.resolve();
      expect(
        typeof init.body === 'string' || init.body instanceof URLSearchParams
          ? init.body.toString()
          : '',
      ).toContain('refresh_token=a%26b%2Bc');
      return new Response('secret-detail', { status: 400 });
    });
    await expect(
      client.tokens({ grant_type: 'refresh_token', refresh_token: 'a&b+c' }),
    ).rejects.toThrow('PROVIDER_REJECTED');
    await expect(client.helix('https://evil.test')).rejects.toThrow('Invalid Helix path');
  });
});
