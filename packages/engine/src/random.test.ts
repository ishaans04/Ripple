import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EngineError } from './errors.ts';
import { createGenerator, generatorFromSeedMaterial, shuffle } from './random.ts';

// Reference xoshiro128** outputs for the state [1, 2, 3, 4] (Blackman and Vigna).
const referenceOutputs = [
  11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597,
  4258142804,
];

const anySeedMaterial = fc.record({ seed: fc.string(), round: fc.nat() });

describe('createGenerator', () => {
  it('reproduces the reference xoshiro128** sequence', () => {
    const generator = createGenerator([1, 2, 3, 4]);
    expect(referenceOutputs.map(() => generator.nextUint32())).toEqual(referenceOutputs);
  });

  it('rejects the all-zero state, which xoshiro cannot leave', () => {
    expect(() => createGenerator([0, 0, 0, 0])).toThrow(EngineError);
  });

  it('rejects state words outside uint32', () => {
    expect(() => createGenerator([1, 2, 3, 2 ** 32])).toThrow(EngineError);
    expect(() => createGenerator([1, 2, 3, -1])).toThrow(EngineError);
  });
});

describe('nextInt', () => {
  it('maps an accepted draw by remainder', () => {
    expect(createGenerator([1, 2, 3, 4]).nextInt(7)).toBe(11520 % 7);
  });

  it('redraws instead of folding the biased tail of the uint32 range', () => {
    const generator = createGenerator([1, 2, 3, 4]);
    for (let skipped = 0; skipped < 7; skipped += 1) {
      generator.nextUint32();
    }
    // 3734860849 lies above the largest multiple of the bound and is redrawn;
    // plain modulo would have returned 4860849.
    expect(generator.nextInt(3_730_000_000)).toBe(3729100597);
  });

  it('stays within [0, bound)', () => {
    fc.assert(
      fc.property(anySeedMaterial, fc.integer({ min: 1, max: 2 ** 32 }), (material, bound) => {
        const value = generatorFromSeedMaterial(material).nextInt(bound);
        expect(Number.isSafeInteger(value) && value >= 0 && value < bound).toBe(true);
      }),
    );
  });

  it.each([0, -1, 1.5, 2 ** 32 + 1])('rejects bound %d', (bound) => {
    expect(() => createGenerator([1, 2, 3, 4]).nextInt(bound)).toThrow(EngineError);
  });
});

describe('generatorFromSeedMaterial', () => {
  it('seeds from the big-endian words of SHA-256 over the canonical JSON', () => {
    const digest = createHash('sha256').update('{"a":1,"b":"x"}', 'utf8').digest();
    const words = [0, 4, 8, 12].map((offset) => digest.readUInt32BE(offset)) as [
      number,
      number,
      number,
      number,
    ];
    const expected = createGenerator(words);
    const actual = generatorFromSeedMaterial({ b: 'x', a: 1 });
    for (let draw = 0; draw < 8; draw += 1) {
      expect(actual.nextUint32()).toBe(expected.nextUint32());
    }
  });
});

describe('shuffle', () => {
  it('performs a Durstenfeld Fisher-Yates shuffle', () => {
    // Draws 11520 % 5, 0 % 4, 5927040 % 3, 70819200 % 2 = 0, 0, 0, 0 swap
    // positions 4, 3, 2, 1 with position 0 in turn.
    expect(shuffle([0, 1, 2, 3, 4], createGenerator([1, 2, 3, 4]))).toEqual([1, 2, 3, 4, 0]);
  });

  it('returns a permutation and leaves its input untouched', () => {
    fc.assert(
      fc.property(anySeedMaterial, fc.array(fc.integer()), (material, items) => {
        const before = [...items];
        const shuffled = shuffle(items, generatorFromSeedMaterial(material));
        expect(items).toEqual(before);
        expect([...shuffled].sort((a, b) => a - b)).toEqual([...items].sort((a, b) => a - b));
      }),
    );
  });

  it('is reproducible from the same seed material', () => {
    fc.assert(
      fc.property(anySeedMaterial, fc.array(fc.integer()), (material, items) => {
        expect(shuffle(items, generatorFromSeedMaterial(material))).toEqual(
          shuffle(items, generatorFromSeedMaterial({ ...material })),
        );
      }),
    );
  });
});
