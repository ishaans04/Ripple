import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from './canonical.ts';
import { EngineError } from './errors.ts';

function toSafeInteger(value: number): number {
  const truncated = Math.trunc(value);
  return Number.isSafeInteger(truncated) ? truncated : 0;
}

// Canonical JSON admits safe integers only; fast-check's JSON values include any double.
const jsonValue = fc
  .jsonValue()
  .map((value): unknown =>
    JSON.parse(
      JSON.stringify(value, (_key, v: unknown) => (typeof v === 'number' ? toSafeInteger(v) : v)),
    ),
  );

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  }
  return value;
}

describe('canonicalJson', () => {
  it('sorts object keys and omits insignificant whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: -2, y: 'é' } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":"é","z":-2}}',
    );
  });

  it('orders keys by UTF-16 code units', () => {
    // By code point U+1F600 follows U+FFFD; by code unit its leading surrogate 0xD83D precedes it.
    const replacement = String.fromCharCode(0xfffd);
    expect(canonicalJson({ [replacement]: 1, '😀': 2, z: 3, é: 4 })).toBe(
      `{"z":3,"é":4,"😀":2,"${replacement}":1}`,
    );
  });

  it('escapes strings exactly as JSON does', () => {
    expect(canonicalJson('quote " slash \\ line\nend \u0001')).toBe(
      '"quote \\" slash \\\\ line\\nend \\u0001"',
    );
  });

  it('does not depend on property insertion order', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(canonicalJson(reverseKeys(value))).toBe(canonicalJson(value));
      }),
    );
  });

  it('parses back to the same value', () => {
    fc.assert(
      fc.property(jsonValue, (value) => {
        expect(JSON.parse(canonicalJson(value))).toStrictEqual(value);
      }),
    );
  });

  it.each([
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', 2 ** 53],
    ['undefined', undefined],
    ['a bigint', 1n],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a date', new Date(0)],
    ['a map', new Map()],
    ['an undefined property', { a: undefined }],
    ['an array hole', new Array(2)],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(EngineError);
  });

  it('rejects cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(EngineError);
  });

  it('accepts a repeated non-cyclic reference', () => {
    const shared = { n: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"n":1},"b":{"n":1}}');
  });
});

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ])('hashes the FIPS 180-2 vector %j', (input, digest) => {
    expect(sha256Hex(input)).toBe(digest);
  });

  it('hashes the UTF-8 encoding of any string, matching node:crypto', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (input) => {
        expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
      }),
    );
  });
});
