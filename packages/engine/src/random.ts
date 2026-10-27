import { canonicalJson, sha256Bytes } from './canonical.ts';
import { EngineError } from './errors.ts';

/*
 * The engine's only source of randomness. The generator is xoshiro128**
 * (Blackman and Vigna) over four uint32 words, computed with Math.imul and
 * unsigned shifts so every output is an exact integer. Seeds are recorded
 * material, never the clock: SHA-256 of the material's canonical JSON supplies
 * the initial state as four big-endian words.
 */

const UINT32_RANGE = 2 ** 32;

export type GeneratorState = readonly [number, number, number, number];

export interface SeededGenerator {
  /** Next raw output as an unsigned 32-bit integer. */
  nextUint32(): number;
  /**
   * Uniform integer in [0, bound) for an integer bound in [1, 2^32]. Draws at
   * or above the largest multiple of bound are redrawn, so no result is biased.
   */
  nextInt(bound: number): number;
}

function rotl(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

export function createGenerator(state: GeneratorState): SeededGenerator {
  if (!state.every((word) => Number.isInteger(word) && word >= 0 && word < UINT32_RANGE)) {
    throw new EngineError('INVALID_ARGUMENT', 'generator state words must be uint32 values');
  }
  if (state.every((word) => word === 0)) {
    throw new EngineError('INVALID_ARGUMENT', 'xoshiro128** cannot start from the all-zero state');
  }
  let [s0, s1, s2, s3] = state;

  const nextUint32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const shifted = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= shifted;
    s3 = rotl(s3, 11);
    return result;
  };

  const nextInt = (bound: number): number => {
    if (!Number.isInteger(bound) || bound < 1 || bound > UINT32_RANGE) {
      throw new EngineError('INVALID_ARGUMENT', 'bound must be an integer in [1, 2^32]');
    }
    const limit = UINT32_RANGE - (UINT32_RANGE % bound);
    for (;;) {
      const draw = nextUint32();
      if (draw < limit) {
        return draw % bound;
      }
    }
  };

  return { nextUint32, nextInt };
}

/** A generator seeded from SHA-256 of the canonical JSON of recorded material. */
export function generatorFromSeedMaterial(material: unknown): SeededGenerator {
  const digest = sha256Bytes(canonicalJson(material));
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  // DataView reads big-endian unless told otherwise.
  return createGenerator([
    view.getUint32(0),
    view.getUint32(4),
    view.getUint32(8),
    view.getUint32(12),
  ]);
}

/** Durstenfeld's Fisher-Yates shuffle into a new array; the input is not modified. */
export function shuffle<T>(items: readonly T[], generator: SeededGenerator): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapWith = generator.nextInt(index + 1);
    // Both positions are within bounds: 0 <= swapWith <= index < length.
    const held = result[index] as T;
    result[index] = result[swapWith] as T;
    result[swapWith] = held;
  }
  return result;
}
