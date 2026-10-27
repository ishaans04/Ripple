import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EngineError } from './errors.ts';
import {
  GENES,
  applyMove,
  assertLegalGenome,
  isLegalGenome,
  legalMoves,
  moveId,
  type Genome,
  type GenomeRules,
} from './genome.ts';

const rules: GenomeRules = { min: 0, max: 15, budget: 24, mutationStep: 2 };

function genome(pulse: number, calm: number, grit: number, drift: number): Genome {
  return { pulse, calm, grit, drift };
}

function allLegalGenomes(): Genome[] {
  const found: Genome[] = [];
  for (let pulse = 0; pulse <= 15; pulse += 1) {
    for (let calm = 0; calm <= 15; calm += 1) {
      for (let grit = 0; grit <= 15; grit += 1) {
        const candidate = genome(pulse, calm, grit, 24 - pulse - calm - grit);
        if (isLegalGenome(candidate, rules)) {
          found.push(candidate);
        }
      }
    }
  }
  return found;
}

const legalGenome = fc.constantFrom(...allLegalGenomes());

describe('isLegalGenome', () => {
  it('accepts the founder genome', () => {
    expect(isLegalGenome(genome(6, 6, 6, 6), rules)).toBe(true);
  });

  it.each([
    ['a budget above 24', genome(6, 6, 6, 7)],
    ['a budget below 24', genome(6, 6, 6, 5)],
    ['a gene above 15', genome(16, 8, 0, 0)],
    ['a negative gene', genome(-1, 9, 8, 8)],
    ['a fractional gene', genome(6.5, 5.5, 6, 6)],
  ])('rejects %s', (_label, candidate) => {
    expect(isLegalGenome(candidate, rules)).toBe(false);
  });

  it('rejects a genome with a missing or extra gene', () => {
    expect(isLegalGenome({ pulse: 8, calm: 8, grit: 8 } as unknown as Genome, rules)).toBe(false);
    expect(isLegalGenome({ ...genome(6, 6, 6, 6), hype: 0 } as Genome, rules)).toBe(false);
  });

  it('admits exactly the 2265 genomes with genes in [0, 15] summing to 24', () => {
    expect(allLegalGenomes()).toHaveLength(2265);
  });

  it('assertLegalGenome raises ILLEGAL_GENOME', () => {
    expect(() => {
      assertLegalGenome(genome(15, 15, 0, 0), rules);
    }).toThrow(expect.objectContaining({ code: 'ILLEGAL_GENOME' }));
  });
});

describe('legalMoves', () => {
  it('lists every two-point transfer from the founder, sorted by gained then lost gene', () => {
    expect(legalMoves(genome(6, 6, 6, 6), rules).map(moveId)).toEqual([
      'pulse+2/calm-2',
      'pulse+2/grit-2',
      'pulse+2/drift-2',
      'calm+2/pulse-2',
      'calm+2/grit-2',
      'calm+2/drift-2',
      'grit+2/pulse-2',
      'grit+2/calm-2',
      'grit+2/drift-2',
      'drift+2/pulse-2',
      'drift+2/calm-2',
      'drift+2/grit-2',
    ]);
  });

  it('omits moves that would leave the bounds', () => {
    // Pulse 15 cannot gain; Grit and Drift at 0 cannot give.
    expect(legalMoves(genome(15, 9, 0, 0), rules).map(moveId)).toEqual([
      'calm+2/pulse-2',
      'grit+2/pulse-2',
      'grit+2/calm-2',
      'drift+2/pulse-2',
      'drift+2/calm-2',
    ]);
  });

  it('only produces legal genomes with the conserved budget', () => {
    fc.assert(
      fc.property(legalGenome, (start) => {
        for (const move of legalMoves(start, rules)) {
          const next = applyMove(start, move, rules);
          expect(next).not.toBeNull();
          expect(isLegalGenome(next!, rules)).toBe(true);
        }
      }),
    );
  });

  it('offers at least three moves from every legal genome', () => {
    for (const start of allLegalGenomes()) {
      expect(legalMoves(start, rules).length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('applyMove', () => {
  it('transfers the step from one gene to another', () => {
    expect(applyMove(genome(6, 6, 6, 6), { from: 'drift', to: 'calm', amount: 2 }, rules)).toEqual(
      genome(6, 8, 6, 4),
    );
  });

  it('returns null when the result would be illegal', () => {
    expect(applyMove(genome(15, 9, 0, 0), { from: 'grit', to: 'calm', amount: 2 }, rules)).toBe(
      null,
    );
    expect(applyMove(genome(15, 9, 0, 0), { from: 'calm', to: 'pulse', amount: 2 }, rules)).toBe(
      null,
    );
  });

  it('rejects a move that does not transfer the configured step between two genes', () => {
    const start = genome(6, 6, 6, 6);
    for (const move of [
      { from: 'calm', to: 'calm', amount: 2 },
      { from: 'calm', to: 'pulse', amount: 4 },
      { from: 'calm', to: 'pulse', amount: 0 },
      { from: 'calm', to: 'hype', amount: 2 },
    ] as const) {
      expect(() => applyMove(start, move as never, rules)).toThrow(EngineError);
    }
  });

  it('rejects an illegal starting genome', () => {
    expect(() =>
      applyMove(genome(6, 6, 6, 7), { from: 'drift', to: 'calm', amount: 2 }, rules),
    ).toThrow(expect.objectContaining({ code: 'ILLEGAL_GENOME' }));
  });

  it('never changes the genes outside the move', () => {
    fc.assert(
      fc.property(legalGenome, (start) => {
        for (const move of legalMoves(start, rules)) {
          const next = applyMove(start, move, rules)!;
          for (const gene of GENES) {
            if (gene !== move.from && gene !== move.to) {
              expect(next[gene]).toBe(start[gene]);
            }
          }
        }
      }),
    );
  });
});
