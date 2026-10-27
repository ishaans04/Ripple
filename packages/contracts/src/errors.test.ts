import { describe, expect, it } from 'vitest';
import { errorCodes, errorResponseSchema } from './errors.ts';

describe('error contract', () => {
  it('keeps error codes unique and upper snake case', () => {
    expect(new Set(errorCodes).size).toBe(errorCodes.length);
    for (const code of errorCodes) expect(code).toMatch(/^[A-Z]+(?:_[A-Z]+)*$/);
  });

  it('requires a known code and a request id', () => {
    expect(
      errorResponseSchema.safeParse({
        error: { code: 'NOT_FOUND', message: 'Route not found', requestId: 'req-1' },
      }).success,
    ).toBe(true);
    expect(
      errorResponseSchema.safeParse({ error: { code: 'TEAPOT', message: 'x', requestId: 'r' } })
        .success,
    ).toBe(false);
    expect(
      errorResponseSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'x' } }).success,
    ).toBe(false);
  });
});
