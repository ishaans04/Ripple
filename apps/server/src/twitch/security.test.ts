import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptTokens, encryptTokens, privateHash, readTwitchConfig } from './security.ts';

describe('live credential boundaries', () => {
  const key = randomBytes(32).toString('base64');
  it('requires an exact registered redirect, independent session key and compatible ruleset', () => {
    const env = {
      ENABLE_LIVE_TWITCH: 'true',
      PUBLIC_BASE_URL: 'https://ripple.example',
      TWITCH_REDIRECT_URI: 'https://ripple.example/auth/twitch/callback',
      TWITCH_CLIENT_ID: 'application123',
      TWITCH_CLIENT_SECRET: 'private-client-secret',
      TWITCH_EVENTSUB_SECRET: 's'.repeat(64),
      TOKEN_ENCRYPTION_KEY: key,
      ACTOR_HASH_KEY: randomBytes(32).toString('base64'),
      SESSION_SECRET: randomBytes(32).toString('base64'),
      OPERATOR_SECRET: 'o'.repeat(40),
    };
    expect(readTwitchConfig(env)?.origin).toBe('https://ripple.example');
    expect(() => readTwitchConfig({ ...env, PUBLIC_BASE_URL: 'http://ripple.example' })).toThrow();
    expect(() =>
      readTwitchConfig({
        ...env,
        TWITCH_REDIRECT_URI: 'https://other.example/auth/twitch/callback',
      }),
    ).toThrow('TWITCH_REDIRECT_URI');
    expect(() => readTwitchConfig({ ...env, SESSION_SECRET: key })).toThrow('must differ');
    expect(() => readTwitchConfig({ ...env, RULESET_VERSION: 'unknown' })).toThrow(
      'RULESET_VERSION',
    );
    // Cocoon Studio is available by default and can be closed for the whole installation.
    expect(readTwitchConfig(env)?.studio).toBe(true);
    expect(readTwitchConfig({ ...env, ENABLE_COCOON_STUDIO: 'false' })?.studio).toBe(false);
    expect(() => readTwitchConfig({ ...env, ENABLE_COCOON_STUDIO: 'off' })).toThrow(
      'ENABLE_COCOON_STUDIO',
    );
  });
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
