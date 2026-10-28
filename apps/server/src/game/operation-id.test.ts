import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { operationId } from './operation-id.ts';
describe('durable internal command identifiers', () => {
  it('uses valid stable UUIDv8 values so accepted retries and isolated replay share an identity', () => {
    const first = operationId('channel', 1, 'admissions');
    expect(z.uuid().parse(first)).toBe(first);
    expect(first[14]).toBe('8');
    expect(operationId('channel', 1, 'admissions')).toBe(first);
    expect(operationId('channel', 2, 'admissions')).not.toBe(first);
    expect(operationId('channel', 1, 'round')).not.toBe(first);
  });
});
