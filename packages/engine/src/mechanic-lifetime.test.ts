import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  candidateMechanicsPolicy,
  consumeValidRound,
  inheritValidRoundLifetime,
  mechanicsPolicyHash,
  newValidRoundLifetime,
} from './mechanic-lifetime.ts';

describe('finite observation-based mechanic lifetimes', () => {
  it('counts only distinct valid closes after capture, even when old closes are redelivered later', () => {
    let life = newValidRoundLifetime('capture', 3);
    for (const [id, valid] of [
      ['capture', true],
      ['quiet', false],
      ['one', true],
      ['two', true],
      ['one', true],
    ] as const)
      life = consumeValidRound(life, id, valid);
    expect(life.remainingRounds).toBe(1);
    life = consumeValidRound(life, 'three', true);
    expect(life.remainingRounds).toBe(0);
    expect(consumeValidRound(life, 'four', true)).toBe(life);
  });
  it('equals the capped count of unique valid observations across generated duplicates and outages', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.array(
          fc.record({
            id: fc.constantFrom('capture', 'a', 'b', 'c', 'd', 'e'),
            valid: fc.boolean(),
            migrate: fc.boolean(),
          }),
          { maxLength: 100 },
        ),
        (allowance, events) => {
          let life = newValidRoundLifetime('capture', allowance);
          const valid = new Set<string>();
          for (const event of events) {
            const before = structuredClone(life);
            if (event.migrate) {
              const inherited = inheritValidRoundLifetime(life);
              expect(inherited).toEqual(before);
              life = inherited;
            }
            const previous = life;
            life = consumeValidRound(life, event.id, event.valid);
            if (event.valid && event.id !== 'capture') valid.add(event.id);
            expect(previous).toEqual(before);
            expect(life.remainingRounds).toBe(Math.max(0, allowance - valid.size));
            expect(life.countedRoundIds.length).toBe(Math.min(allowance, valid.size));
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
  it('freezes inherited state and rejects impossible or unbounded allowances', () => {
    const captured = newValidRoundLifetime('birth', 3),
      inherited = inheritValidRoundLifetime(captured);
    expect(Object.isFrozen(inherited)).toBe(true);
    expect(Object.isFrozen(inherited.countedRoundIds)).toBe(true);
    expect(() => newValidRoundLifetime('birth', 4)).toThrow();
    expect(() =>
      consumeValidRound({ ...captured, countedRoundIds: ['a', 'a'] }, 'b', true),
    ).toThrow();
    expect(() =>
      consumeValidRound({ ...captured, countedRoundIds: ['birth'] }, 'b', true),
    ).toThrow();
  });
  it('pins the three-round policy without changing the original scoring rules', () => {
    expect(candidateMechanicsPolicy).toEqual({
      version: 'mechanics-policy-1',
      dormantRounds: 3,
      traceRounds: 3,
      pendingTraceRounds: 3,
    });
    expect(mechanicsPolicyHash(candidateMechanicsPolicy)).toBe(
      'c70ee0c3619914e967ef2cb0c27c8cb0166c3fe9a60be8973eaf89bc5a6f54cd',
    );
  });
});
