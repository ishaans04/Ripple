import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EngineError } from './errors.ts';
import { clamp, floorDiv, roundHalfUp } from './integer.ts';

describe('floorDiv', () => {
  it.each([
    [7, 2, 3],
    [-7, 2, -4],
    [-6, 3, -2],
    [0, 5, 0],
    [45600, 15000, 3],
  ])('floorDiv(%i, %i) = %i', (numerator, denominator, expected) => {
    expect(floorDiv(numerator, denominator)).toBe(expected);
  });

  it('agrees with exact BigInt floor division across the safe integer range', () => {
    fc.assert(
      fc.property(
        fc.maxSafeInteger(),
        fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
        (numerator, denominator) => {
          const q = BigInt(floorDiv(numerator, denominator));
          const n = BigInt(numerator);
          const d = BigInt(denominator);
          expect(q * d <= n && n < (q + 1n) * d).toBe(true);
        },
      ),
    );
  });

  it('rejects a zero or negative denominator', () => {
    expect(() => floorDiv(1, 0)).toThrow(EngineError);
    expect(() => floorDiv(1, -2)).toThrow(EngineError);
  });

  it('rejects fractional and unsafe operands', () => {
    expect(() => floorDiv(1.5, 2)).toThrow(EngineError);
    expect(() => floorDiv(2 ** 53, 2)).toThrow(EngineError);
    expect(() => floorDiv(Number.NaN, 2)).toThrow(EngineError);
  });
});

describe('roundHalfUp', () => {
  it.each([
    [5, 2, 3],
    [-5, 2, -2],
    [1, 3, 0],
    [2, 3, 1],
    [45600, 15000, 3],
    [37200, 15000, 2],
    [36000, 15000, 2],
    [37500, 15000, 3],
  ])('roundHalfUp(%i / %i) = %i', (numerator, denominator, expected) => {
    expect(roundHalfUp(numerator, denominator)).toBe(expected);
  });

  it('is never more than one half away from the exact quotient', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -(2 ** 40), max: 2 ** 40 }),
        fc.integer({ min: 1, max: 2 ** 40 }),
        (numerator, denominator) => {
          const r = BigInt(roundHalfUp(numerator, denominator));
          const n = BigInt(numerator);
          const d = BigInt(denominator);
          // r - 1/2 <= n/d < r + 1/2, i.e. (2r - 1)d <= 2n < (2r + 1)d.
          expect((2n * r - 1n) * d <= 2n * n && 2n * n < (2n * r + 1n) * d).toBe(true);
        },
      ),
    );
  });
});

describe('clamp', () => {
  it.each([
    [5, 0, 3, 3],
    [-1, 0, 3, 0],
    [2, 0, 3, 2],
  ])('clamp(%i, %i, %i) = %i', (value, min, max, expected) => {
    expect(clamp(value, min, max)).toBe(expected);
  });

  it('rejects an empty range', () => {
    expect(() => clamp(1, 3, 2)).toThrow(EngineError);
  });
});
