import { StudioRuleError } from './studio-blueprint.ts';

export interface MutationSlots {
  readonly next: number;
  readonly lastMutation: number;
  readonly observedThrough: number;
  readonly reservation: { readonly adaptationId: string; readonly slot: number } | null;
  readonly commitments: readonly {
    readonly operationId: string;
    readonly slot: number;
    readonly fingerprint?: string;
  }[];
}
export const initialMutationSlots: MutationSlots = Object.freeze({
  next: 1,
  lastMutation: 0,
  observedThrough: 0,
  reservation: null,
  commitments: Object.freeze([]),
});

function checkSlots(state: MutationSlots): void {
  if (
    ![state.next, state.lastMutation, state.observedThrough].every(Number.isSafeInteger) ||
    state.next !== state.lastMutation + 1 ||
    state.lastMutation < 0 ||
    state.observedThrough < 0 ||
    state.observedThrough > state.lastMutation
  ) {
    throw new StudioRuleError('SLOT_UNAVAILABLE', 'Invalid mutation clock checkpoint.');
  }
}

export function canUseMutationSlot(state: MutationSlots): boolean {
  checkSlots(state);
  return state.observedThrough === state.lastMutation && state.reservation === null;
}

export function reserveMutationSlot(
  state: MutationSlots,
  adaptationId: string,
  slot: number,
): MutationSlots {
  checkSlots(state);
  if (adaptationId.length === 0)
    throw new StudioRuleError('SLOT_UNAVAILABLE', 'A reservation needs an operation ID.');
  if (state.reservation?.adaptationId === adaptationId && state.reservation.slot === slot)
    return state;
  if (state.reservation !== null)
    throw new StudioRuleError(
      'PENDING_ADAPTATION_EXISTS',
      'This organism already has a pending adaptation.',
    );
  if (
    !canUseMutationSlot(state) ||
    slot !== state.next ||
    state.commitments.some((item) => item.operationId === adaptationId)
  ) {
    throw new StudioRuleError(
      'SLOT_UNAVAILABLE',
      'Finish the required observation before another mutation.',
    );
  }
  return { ...state, reservation: { adaptationId, slot } };
}

/**
 * Approval may happen while the current slot's observation is still outstanding (a break can
 * interrupt any phase). It reserves only the next slot; consumeMutationSlot still refuses to
 * commit it until that observation completes, so no required observation is ever skipped.
 */
export function reserveNextMutationSlot(
  state: MutationSlots,
  adaptationId: string,
  slot: number,
): MutationSlots {
  checkSlots(state);
  if (adaptationId.length === 0)
    throw new StudioRuleError('SLOT_UNAVAILABLE', 'A reservation needs an operation ID.');
  if (state.reservation?.adaptationId === adaptationId && state.reservation.slot === slot)
    return state;
  if (state.reservation !== null)
    throw new StudioRuleError(
      'PENDING_ADAPTATION_EXISTS',
      'This organism already has a pending adaptation.',
    );
  if (slot !== state.next || state.commitments.some((item) => item.operationId === adaptationId))
    throw new StudioRuleError('SLOT_UNAVAILABLE', 'Only the next mutation slot can be reserved.');
  return { ...state, reservation: { adaptationId, slot } };
}

export function releaseMutationSlot(state: MutationSlots, adaptationId: string): MutationSlots {
  checkSlots(state);
  return state.reservation?.adaptationId === adaptationId ? { ...state, reservation: null } : state;
}

/** Used by both ordinary mutations and studio hatches. Breaks never advance this clock. */
export function consumeMutationSlot(
  state: MutationSlots,
  operationId: string,
  slot: number,
  fingerprint?: string,
): MutationSlots {
  checkSlots(state);
  const previous = state.commitments.find((item) => item.operationId === operationId);
  if (previous !== undefined) {
    if (previous.slot !== slot || previous.fingerprint !== fingerprint)
      throw new StudioRuleError('SLOT_UNAVAILABLE', 'Operation ID was used for a different slot.');
    return state;
  }
  if (
    operationId.length === 0 ||
    slot !== state.next ||
    state.observedThrough !== state.lastMutation ||
    (state.reservation !== null && state.reservation.adaptationId !== operationId)
  ) {
    throw new StudioRuleError('SLOT_UNAVAILABLE', 'The mutation slot is unavailable or reserved.');
  }
  return {
    ...state,
    next: slot + 1,
    lastMutation: slot,
    reservation: null,
    commitments: [
      ...state.commitments,
      { operationId, slot, ...(fingerprint === undefined ? {} : { fingerprint }) },
    ],
  };
}

export function completeSlotObservation(
  state: MutationSlots,
  slot: number,
  valid: boolean,
): MutationSlots {
  checkSlots(state);
  if (!valid) return state;
  if (slot !== state.lastMutation)
    throw new StudioRuleError(
      'SLOT_UNAVAILABLE',
      'Observation belongs to a different mutation slot.',
    );
  return { ...state, observedThrough: slot };
}

export function studioEligibility(input: {
  readonly enabled: boolean;
  readonly online: boolean;
  readonly healthy: boolean;
  readonly status: 'ALIVE' | 'HARBOR' | 'FOSSIL' | 'ARCHIVED';
  readonly availability: 'ACTIVE' | 'REST' | 'UNKNOWN';
  readonly slots: MutationSlots;
}): { readonly eligible: true } | { readonly eligible: false; readonly reason: string } {
  if (!input.enabled) return { eligible: false, reason: 'studio_disabled' };
  if (!input.online) return { eligible: false, reason: 'stream_offline' };
  if (!input.healthy || input.availability === 'UNKNOWN')
    return { eligible: false, reason: 'integration_unknown' };
  if (input.availability !== 'REST') return { eligible: false, reason: 'not_on_break' };
  if (input.status !== 'ALIVE') return { eligible: false, reason: 'organism_inactive' };
  if (!canUseMutationSlot(input.slots))
    return { eligible: false, reason: 'mutation_slot_unavailable' };
  return { eligible: true };
}
