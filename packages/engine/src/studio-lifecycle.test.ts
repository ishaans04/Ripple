import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { founderShell } from '@ripple/contracts';
import {
  isTerminalStudioPhase,
  nextStudioPhase,
  requireStudioTransition,
  studioHoldsGame,
  studioOpeningEligibility,
  studioPhases,
  type StudioEvent,
} from './studio-lifecycle.ts';
import {
  completeSlotObservation,
  consumeMutationSlot,
  initialMutationSlots,
  releaseMutationSlot,
  reserveNextMutationSlot,
} from './studio-slots.ts';
import { approveStudioAdaptation, commitStudioAdaptation } from './studio-adaptation.ts';
import { createStudioChallenge } from './studio-challenge.ts';
import { candidateRuleset as rules } from './ruleset.ts';

const events: StudioEvent[] = [
  'captured',
  'creation_closed',
  'creation_unavailable',
  'selection_keep_current',
  'selection_review',
  'selection_auto_approved',
  'approved',
  'rejected',
  'review_expired',
  'hatched',
  'host_returned',
  'host_cancelled',
  'offline',
  'base_invalid',
  'organism_fossilized',
  'released',
];

describe('studio lifecycle', () => {
  it('never leaves a terminal phase and only reaches documented phases', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...events), { maxLength: 60 }), (sequence) => {
        let phase: (typeof studioPhases)[number] = 'OPENING';
        for (const event of sequence) {
          const next = nextStudioPhase(phase, event);
          if (isTerminalStudioPhase(phase)) expect(next).toBeNull();
          if (next !== null) {
            expect(studioPhases).toContain(next);
            phase = next;
          }
        }
      }),
    );
  });
  it('follows the addendum transitions and the recorded Keep current and expiry outcomes', () => {
    expect(nextStudioPhase('OPENING', 'captured')).toBe('CREATING');
    expect(nextStudioPhase('CREATING', 'creation_closed')).toBe('VOTING');
    expect(nextStudioPhase('VOTING', 'selection_review')).toBe('REVIEW');
    expect(nextStudioPhase('REVIEW', 'approved')).toBe('PENDING_HATCH');
    expect(nextStudioPhase('REVIEW', 'rejected')).toBe('CANCELLED');
    expect(nextStudioPhase('PENDING_HATCH', 'hatched')).toBe('COMPLETED');
    expect(nextStudioPhase('CREATING', 'host_returned')).toBe('CANCELLED');
    expect(nextStudioPhase('VOTING', 'host_cancelled')).toBe('CANCELLED');
    expect(nextStudioPhase('VOTING', 'selection_keep_current')).toBe('COMPLETED');
    expect(nextStudioPhase('REVIEW', 'review_expired')).toBe('EXPIRED');
    // A return during voting follows the finish/cancel policy, never this event.
    expect(nextStudioPhase('VOTING', 'host_returned')).toBeNull();
    // An accepted result survives offline status for explicit recovery.
    expect(nextStudioPhase('REVIEW', 'offline')).toBeNull();
    expect(nextStudioPhase('PENDING_HATCH', 'offline')).toBeNull();
    expect(() => requireStudioTransition('COMPLETED', 'approved')).toThrow(/during COMPLETED/);
  });
  it('holds the game only while a decision is still owed', () => {
    expect(studioPhases.filter(studioHoldsGame)).toEqual([
      'OPENING',
      'CREATING',
      'VOTING',
      'REVIEW',
    ]);
  });
  it('opens only for an enabled healthy live channel with a living resident and no pending design', () => {
    const input = {
      enabled: true,
      online: true,
      healthy: true,
      status: 'ALIVE' as const,
      slots: initialMutationSlots,
      activeSession: false,
    };
    expect(studioOpeningEligibility(input)).toEqual({ eligible: true });
    // An unobserved slot does not block opening: the commit still waits for observation.
    expect(
      studioOpeningEligibility({
        ...input,
        slots: consumeMutationSlot(initialMutationSlots, 'm', 1),
      }),
    ).toEqual({ eligible: true });
    const cases = [
      [{ enabled: false }, 'studio_disabled'],
      [{ online: false }, 'stream_offline'],
      [{ healthy: false }, 'integration_unknown'],
      [{ activeSession: true }, 'studio_active'],
      [{ status: null, slots: null }, 'no_resident'],
      [{ status: 'FOSSIL' as const }, 'organism_inactive'],
      [
        { slots: reserveNextMutationSlot(initialMutationSlots, 'pending', 1) },
        'pending_adaptation_exists',
      ],
    ] as const;
    for (const [change, reason] of cases)
      expect(studioOpeningEligibility({ ...input, ...change })).toEqual({
        eligible: false,
        reason,
      });
  });
});

describe('future slot reservation', () => {
  it('reserves the next slot during an outstanding observation but never commits before it', () => {
    const consumed = consumeMutationSlot(initialMutationSlots, 'ordinary-1', 1);
    const reserved = reserveNextMutationSlot(consumed, 'studio', 2);
    expect(reserved.reservation).toEqual({ adaptationId: 'studio', slot: 2 });
    expect(() => consumeMutationSlot(reserved, 'studio', 2)).toThrow();
    expect(() => consumeMutationSlot(reserved, 'ordinary-2', 2)).toThrow();
    const observed = completeSlotObservation(reserved, 1, true);
    expect(consumeMutationSlot(observed, 'studio', 2).lastMutation).toBe(2);
    expect(() => reserveNextMutationSlot(reserved, 'other', 2)).toThrow(/pending adaptation/);
    expect(() => reserveNextMutationSlot(consumed, 'studio', 3)).toThrow(/next mutation slot/);
    expect(reserveNextMutationSlot(reserved, 'studio', 2)).toBe(reserved);
  });
  it('adds no genetic change across generated break, approval, release and observation sequences', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('reserve', 'release', 'observe', 'interrupt', 'hatch', 'normal'), {
          maxLength: 120,
        }),
        (commands) => {
          let state = initialMutationSlots;
          let observations = 0;
          for (const [index, command] of commands.entries()) {
            try {
              if (command === 'reserve')
                state = reserveNextMutationSlot(state, `studio-${index}`, state.next);
              if (command === 'release' && state.reservation !== null)
                state = releaseMutationSlot(state, state.reservation.adaptationId);
              if (command === 'observe') {
                const before = state.observedThrough;
                state = completeSlotObservation(state, state.lastMutation, true);
                if (state.observedThrough !== before) observations += 1;
              }
              if (command === 'interrupt')
                state = completeSlotObservation(state, state.lastMutation, false);
              if (command === 'hatch' && state.reservation !== null)
                state = consumeMutationSlot(state, state.reservation.adaptationId, state.next);
              if (command === 'normal')
                state = consumeMutationSlot(state, `normal-${index}`, state.next);
            } catch {
              /* Rejected commands leave the immutable state unchanged. */
            }
            // Every commitment after the first needs a completed observation in between.
            expect(state.commitments.length).toBeLessThanOrEqual(observations + 1);
            expect(new Set(state.commitments.map((item) => item.slot)).size).toBe(
              state.commitments.length,
            );
          }
        },
      ),
    );
  });
  it('approves a captured challenge into a reservation that commits once at its boundary', () => {
    const organism = {
      id: '00000000-0000-4000-8000-000000000003',
      version: 4,
      status: 'ALIVE' as const,
      genome: rules.genome.founder,
      appearanceHash: null,
      appearance: null,
    };
    const slots = consumeMutationSlot(initialMutationSlots, 'ordinary-1', 1);
    const challenge = createStudioChallenge(
      {
        worldId: '00000000-0000-4000-8000-000000000001',
        studioSessionId: '00000000-0000-4000-8000-000000000002',
        baseOrganismId: organism.id,
        baseOrganismVersion: 4,
        genome: organism.genome,
        baseAppearanceHash: null,
        targetMutationSlot: 2,
      },
      rules,
    );
    const design = {
      schemaVersion: 1,
      worldId: challenge.worldId,
      studioSessionId: challenge.studioSessionId,
      baseOrganismId: organism.id,
      baseOrganismVersion: 4,
      rendererVersion: 'shell-v1',
      mutationTemplateId: challenge.mutationTemplateIds[0],
      part: founderShell,
    };
    const approved = approveStudioAdaptation(
      'adaptation',
      design,
      challenge,
      organism,
      slots,
      rules,
    );
    expect(approved.slots.reservation?.slot).toBe(2);
    expect(() =>
      commitStudioAdaptation(approved.pending, organism, approved.slots, 2, rules),
    ).toThrow();
    const ready = completeSlotObservation(approved.slots, 1, true);
    const committed = commitStudioAdaptation(approved.pending, organism, ready, 2, rules);
    expect(committed.outcome).toBe('committed');
    expect(
      commitStudioAdaptation(approved.pending, committed.organism, committed.slots, 2, rules)
        .outcome,
    ).toBe('already_committed');
    expect(() =>
      approveStudioAdaptation(
        'adaptation',
        design,
        challenge,
        { ...organism, version: 5 },
        slots,
        rules,
      ),
    ).toThrow(/silently rebased/);
  });
});
