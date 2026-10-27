import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const databaseUrl = 'postgres://ripple:s3cret-value@db:5432/ripple';

function configError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies defaults when only the database is configured', () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl })).toEqual({
      databaseUrl,
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      shutdownGraceMs: 15_000,
      webRoot: undefined,
    });
  });

  it('parses explicit values', () => {
    const config = loadConfig({
      DATABASE_URL: databaseUrl,
      HOST: '127.0.0.1',
      PORT: '8080',
      LOG_LEVEL: 'debug',
      SHUTDOWN_GRACE_MS: '5000',
      WEB_ROOT: '/app/web',
    });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'debug',
      shutdownGraceMs: 5000,
      webRoot: resolve('/app/web'),
    });
  });

  it('resolves a relative web root against the working directory', () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl, WEB_ROOT: '../web/dist' }).webRoot).toBe(
      resolve('../web/dist'),
    );
  });

  it('treats empty variables as unset', () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl, PORT: '', WEB_ROOT: '' })).toMatchObject({
      port: 3000,
      webRoot: undefined,
    });
  });

  it('reports a missing database URL by name', () => {
    expect(configError({}).issues).toEqual(['DATABASE_URL is required']);
  });

  it('collects every invalid variable', () => {
    const error = configError({ DATABASE_URL: 'mysql://x', PORT: '70000', LOG_LEVEL: 'loud' });
    expect(error.issues.map((issue) => issue.split(' ')[0])).toEqual([
      'DATABASE_URL',
      'PORT',
      'LOG_LEVEL',
    ]);
  });

  it('never echoes configuration values in errors', () => {
    const error = configError({ DATABASE_URL: databaseUrl, PORT: 'not-a-port' });
    expect(error.message).not.toContain('s3cret-value');
    expect(error.message).not.toContain('not-a-port');
  });
});
