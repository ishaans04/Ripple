import { EngineError } from './errors.ts';

/*
 * Integer behavior of the engine. Every rule operates on safe integers
 * (|n| <= 2^53 - 1) and every division names its rounding explicitly, so a
 * result never depends on floating-point representation.
 */

export function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new EngineError('INVALID_INTEGER', `${name} must be a safe integer`);
  }
}

/** Floor of numerator / denominator, exact for safe integers. Denominator must be positive. */
export function floorDiv(numerator: number, denominator: number): number {
  assertSafeInteger(numerator, 'numerator');
  assertSafeInteger(denominator, 'denominator');
  if (denominator <= 0) {
    throw new EngineError('INVALID_ARGUMENT', 'denominator must be positive');
  }
  // `%` is exact on safe integers, so numerator - remainder is an exact multiple.
  const remainder = numerator % denominator;
  const truncated = (numerator - remainder) / denominator;
  return remainder < 0 ? truncated - 1 : truncated;
}

/**
 * numerator / denominator rounded to the nearest integer, halves toward
 * positive infinity: floor((2n + d) / 2d).
 */
export function roundHalfUp(numerator: number, denominator: number): number {
  assertSafeInteger(numerator, 'numerator');
  assertSafeInteger(denominator, 'denominator');
  return floorDiv(2 * numerator + denominator, 2 * denominator);
}

export function clamp(value: number, min: number, max: number): number {
  assertSafeInteger(value, 'value');
  assertSafeInteger(min, 'min');
  assertSafeInteger(max, 'max');
  if (min > max) {
    throw new EngineError('INVALID_ARGUMENT', 'clamp range is empty');
  }
  return Math.min(max, Math.max(min, value));
}
