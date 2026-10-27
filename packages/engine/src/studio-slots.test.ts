import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  initialMutationSlots,
  reserveMutationSlot,
  consumeMutationSlot,
  releaseMutationSlot,
  completeSlotObservation,
  studioEligibility,
} from './studio-slots.ts';

describe('shared mutation slot clock', () => {
  it('prevents an ordinary mutation from also consuming a studio reservation', () => {
    const reserved = reserveMutationSlot(initialMutationSlots, 'studio-1', 1);
    expect(() => consumeMutationSlot(reserved, 'normal-1', 1)).toThrow();
    const committed = consumeMutationSlot(reserved, 'studio-1', 1);
    expect(consumeMutationSlot(committed, 'studio-1', 1)).toBe(committed);
    expect(() => consumeMutationSlot(committed, 'normal-1', 1)).toThrow();
  });
  it('does not skip active observation on repeated break toggles', () => {
    fc.assert(
      fc.property(fc.nat(100), (toggles) => {
        let state = consumeMutationSlot(initialMutationSlots, 'first', 1);
        for (let i = 0; i < toggles; i += 1) state = releaseMutationSlot(state, `break-${i}`);
        expect(() => reserveMutationSlot(state, 'next', 2)).toThrow();
        expect(() =>
          reserveMutationSlot(completeSlotObservation(state, 1, false), 'next', 2),
        ).toThrow();
        expect(
          reserveMutationSlot(completeSlotObservation(state, 1, true), 'next', 2).reservation?.slot,
        ).toBe(2);
      }),
    );
  });
  it('releases expiry without inventing a commitment and retries reservations safely', () => {
    const reserved = reserveMutationSlot(initialMutationSlots, 'a', 1);
    expect(reserveMutationSlot(reserved, 'a', 1)).toBe(reserved);
    expect(() => reserveMutationSlot(reserved, 'b', 1)).toThrow();
    expect(releaseMutationSlot(reserved, 'a')).toEqual(initialMutationSlots);
  });
  it('requires an enabled healthy live break with an alive organism', () => {
    const input = {
      enabled: true,
      online: true,
      healthy: true,
      status: 'ALIVE' as const,
      availability: 'REST' as const,
      slots: initialMutationSlots,
    };
    expect(studioEligibility(input)).toEqual({ eligible: true });
    for (const change of [
      { online: false },
      { enabled: false },
      { healthy: false },
      { status: 'FOSSIL' as const },
      { availability: 'UNKNOWN' as const },
    ]) {
      expect(studioEligibility({ ...input, ...change }).eligible).toBe(false);
    }
  });
});
