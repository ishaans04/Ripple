import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptTokens, encryptTokens, privateHash, readTwitchConfig } from './security.ts';

describe('live credential boundaries', () => {
  const key = randomBytes(32).toString('base64');
  it('keeps local evaluation independent of Twitch secrets', () => {
    expect(readTwitchConfig({})).toBeUndefined();
    expect(() => readTwitchConfig({ ENABLE_LIVE_TWITCH: 'yes' })).toThrow();
    expect(() =>
      readTwitchConfig({ ENABLE_LIVE_TWITCH: 'true', TWITCH_CLIENT_SECRET: 'never-echo-this' }),
    ).toThrow(/^Invalid live configuration:/);
    try {
      readTwitchConfig({ ENABLE_LIVE_TWITCH: 'true', TWITCH_CLIENT_SECRET: 'never-echo-this' });
    } catch (error) {
      expect(String(error)).not.toContain('never-echo-this');
    }
  });
  it('authenticates ciphertext and binds it to grant identity', () => {
    const tokens = { access: 'access-secret', refresh: 'refresh-secret' };
    const encrypted = encryptTokens(tokens, key, 'grant-one');
    expect(JSON.stringify(encrypted)).not.toContain(tokens.access);
    expect(decryptTokens(encrypted, key, 'grant-one')).toEqual(tokens);
    expect(() => decryptTokens(encrypted, key, 'grant-two')).toThrow();
    expect(() =>
      decryptTokens(encrypted, randomBytes(32).toString('base64'), 'grant-one'),
    ).toThrow();
    expect(encryptTokens(tokens, key, 'grant-one')).not.toEqual(encrypted);
  });
  it('separates identities by world and channel without storing user IDs', () => {
    expect(privateHash(key, 'world', 'one', '123')).not.toBe(
      privateHash(key, 'world', 'two', '123'),
    );
    expect(privateHash(key, 'world', 'one', '123')).toHaveLength(64);
  });
});
