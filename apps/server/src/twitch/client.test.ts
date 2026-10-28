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
};
describe('Twitch transport', () => {
  it('serializes app-token acquisition and renews once after 401', async () => {
    let grants = 0,
      reads = 0;
    const client = new TwitchClient(config, (async (url, init) => {
      if (String(url).includes('/oauth2/token')) {
        grants++;
        expect(String(init?.body)).toContain('grant_type=client_credentials');
        return Response.json({ access_token: `token${grants}`, expires_in: 3600 });
      }
      reads++;
      return reads === 1
        ? new Response('private provider body', { status: 401 })
        : Response.json({ data: [] });
    }) as typeof fetch);
    await Promise.all([client.appToken(), client.appToken()]);
    expect(grants).toBe(1);
    await expect(client.helix('/streams?user_id=1')).resolves.toEqual({ data: [] });
    expect(grants).toBe(2);
    expect(reads).toBe(2);
  });
  it('encodes refresh tokens and keeps failure bodies private', async () => {
    const client = new TwitchClient(config, (async (_url, init) => {
      expect(String(init?.body)).toContain('refresh_token=a%26b%2Bc');
      return new Response('secret-detail', { status: 400 });
    }) as typeof fetch);
    await expect(
      client.tokens({ grant_type: 'refresh_token', refresh_token: 'a&b+c' }),
    ).rejects.toThrow('PROVIDER_REJECTED');
    await expect(client.helix('https://evil.test')).rejects.toThrow('Invalid Helix path');
  });
});
