import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { EngineError } from './errors.ts';

/**
 * Stable serialization for rulesets, seeds, and replay records: the JSON
 * Canonicalization Scheme (RFC 8785) restricted to safe integers. Object keys
 * are sorted by UTF-16 code units, there is no insignificant whitespace, and
 * strings are escaped exactly as JSON.stringify escapes them. Values JSON
 * would silently drop or alter (undefined, holes, non-integers, class
 * instances) are rejected instead.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw nonCanonical('numbers must be safe integers');
      }
      return String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return serializeContainer(value, ancestors);
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      break;
  }
  throw nonCanonical(`a ${typeof value} has no JSON form`);
}

function serializeContainer(value: object, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw nonCanonical('cyclic structures have no JSON form');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw nonCanonical('arrays must not contain holes');
        }
        items.push(serialize(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw nonCanonical('only plain objects have a canonical form');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw nonCanonical('symbol keys have no JSON form');
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) {
          throw nonCanonical(`property ${JSON.stringify(key)} is undefined`);
        }
        return `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`;
      });
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function nonCanonical(reason: string): EngineError {
  return new EngineError('NON_CANONICAL_VALUE', reason);
}

/** SHA-256 of the UTF-8 encoding of text. */
export function sha256Bytes(text: string): Uint8Array {
  return sha256(utf8ToBytes(text));
}

/** Lowercase hexadecimal SHA-256 of the UTF-8 encoding of text. */
export function sha256Hex(text: string): string {
  return bytesToHex(sha256Bytes(text));
}
