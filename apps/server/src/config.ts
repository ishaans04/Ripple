import { resolve } from 'node:path';
import { z } from 'zod';
import { readTwitchConfig, type TwitchConfig } from './twitch/security.ts';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const environmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(8).max(64).default(48),
  /** Time allowed to drain requests and release resources before a forced exit. */
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  /** Directory holding the built web application; omit to serve the API only. */
  WEB_ROOT: z
    .string()
    .min(1)
    .transform((path) => resolve(path))
    .optional(),
});

export interface ServerConfig {
  databaseUrl: string;
  databasePoolMax: number;
  host: string;
  port: number;
  logLevel: (typeof logLevels)[number];
  shutdownGraceMs: number;
  webRoot: string | undefined;
  twitch?: TwitchConfig;
}

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Parse process environment into typed configuration. Error messages name the
 * offending variable but never echo its value, because values may be secrets.
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const definedOnly = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const result = environmentSchema.safeParse(definedOnly);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const variable = issue.path.join('.');
        return issue.code === 'invalid_type' && !(variable in definedOnly)
          ? `${variable} is required`
          : `${variable} ${issue.message}`;
      }),
    );
  }

  const parsed = result.data;
  let twitch: TwitchConfig | undefined;
  try {
    twitch = readTwitchConfig(definedOnly);
  } catch (error) {
    throw new ConfigError([error instanceof Error ? error.message : 'Invalid live configuration']);
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    databasePoolMax: parsed.DATABASE_POOL_MAX,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    shutdownGraceMs: parsed.SHUTDOWN_GRACE_MS,
    webRoot: parsed.WEB_ROOT,
    ...(twitch === undefined ? {} : { twitch }),
  };
}
