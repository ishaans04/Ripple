import { describe, expect, it } from 'vitest';
import { readyHealthSchema } from './health.ts';

describe('readyHealthSchema', () => {
  it('accepts a ready report', () => {
    const report = { status: 'ready', checks: { database: 'ok', migrations: 'current' } };
    expect(readyHealthSchema.parse(report)).toEqual(report);
  });

  it('rejects unknown dependency states', () => {
    const result = readyHealthSchema.safeParse({
      status: 'ready',
      checks: { database: 'degraded', migrations: 'current' },
    });
    expect(result.success).toBe(false);
  });

  it('strips fields outside the contract so configuration cannot leak', () => {
    const parsed = readyHealthSchema.parse({
      status: 'not_ready',
      databaseUrl: 'postgres://secret@db/ripple',
      checks: { database: 'unavailable', migrations: 'unknown', host: 'db.internal' },
    });
    expect(parsed).toEqual({
      status: 'not_ready',
      checks: { database: 'unavailable', migrations: 'unknown' },
    });
  });
});
