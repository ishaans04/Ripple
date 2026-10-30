import { StudioRuleError } from './studio-blueprint.ts';
import type { MutationSlots } from './studio-slots.ts';

/** Server-authoritative studio phases (addendum 8.2). CLOSED is the absence of a session. */
export const studioPhases = [
  'OPENING',
  'CREATING',
  'VOTING',
  'REVIEW',
  'PENDING_HATCH',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type StudioPhase = (typeof studioPhases)[number];
export const terminalStudioPhases: readonly StudioPhase[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

/**
 * Every recorded cause of a studio transition. Each event is allowed only from the phases
 * listed below; anything else is a stale or out-of-order request and changes nothing.
 */
export type StudioEvent =
  | 'captured'
  | 'creation_closed'
  | 'creation_unavailable'
  | 'selection_keep_current'
  | 'selection_review'
  | 'selection_auto_approved'
  | 'approved'
  | 'rejected'
  | 'review_expired'
  | 'hatched'
  | 'host_returned'
  | 'host_cancelled'
  | 'offline'
  | 'base_invalid'
  | 'organism_fossilized'
  | 'released';

const transitions: Readonly<Record<StudioEvent, Partial<Record<StudioPhase, StudioPhase>>>> = {
  captured: { OPENING: 'CREATING' },
  creation_closed: { CREATING: 'VOTING' },
  // Without healthy chat input nobody can vote, so creation expires instead of fabricating a vote.
  creation_unavailable: { CREATING: 'EXPIRED' },
  selection_keep_current: { VOTING: 'COMPLETED' },
  selection_review: { VOTING: 'REVIEW' },
  selection_auto_approved: { VOTING: 'PENDING_HATCH' },
  approved: { REVIEW: 'PENDING_HATCH' },
  rejected: { REVIEW: 'CANCELLED' },
  review_expired: { REVIEW: 'EXPIRED' },
  hatched: { PENDING_HATCH: 'COMPLETED' },
  host_returned: { OPENING: 'CANCELLED', CREATING: 'CANCELLED' },
  host_cancelled: { OPENING: 'CANCELLED', CREATING: 'CANCELLED', VOTING: 'CANCELLED' },
  offline: { OPENING: 'CANCELLED', CREATING: 'CANCELLED', VOTING: 'CANCELLED' },
  base_invalid: { REVIEW: 'CANCELLED', PENDING_HATCH: 'CANCELLED' },
  organism_fossilized: {
    OPENING: 'CANCELLED',
    CREATING: 'CANCELLED',
    VOTING: 'CANCELLED',
    REVIEW: 'CANCELLED',
    PENDING_HATCH: 'CANCELLED',
  },
  released: { PENDING_HATCH: 'CANCELLED' },
};

export function nextStudioPhase(phase: StudioPhase, event: StudioEvent): StudioPhase | null {
  return transitions[event][phase] ?? null;
}

export function isTerminalStudioPhase(phase: StudioPhase): boolean {
  return terminalStudioPhases.includes(phase);
}

/**
 * The studio holds the game clock while chat or the broadcaster still owes a decision. Once a
 * result is pending (or the session ended), play resumes from the round checkpoint.
 */
export function studioHoldsGame(phase: StudioPhase): boolean {
  return phase === 'OPENING' || phase === 'CREATING' || phase === 'VOTING' || phase === 'REVIEW';
}

export type StudioOpeningRefusal =
  | 'studio_disabled'
  | 'stream_offline'
  | 'integration_unknown'
  | 'no_resident'
  | 'organism_inactive'
  | 'pending_adaptation_exists'
  | 'studio_active';

/**
 * Opening needs no observed slot: the design never commits before its boundary, which still
 * requires the intervening observation. It does need a free reservation.
 */
export function studioOpeningEligibility(input: {
  readonly enabled: boolean;
  readonly online: boolean;
  readonly healthy: boolean;
  readonly status: 'ALIVE' | 'HARBOR' | 'FOSSIL' | 'ARCHIVED' | null;
  readonly slots: MutationSlots | null;
  readonly activeSession: boolean;
}):
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: StudioOpeningRefusal } {
  if (!input.enabled) return { eligible: false, reason: 'studio_disabled' };
  if (!input.online) return { eligible: false, reason: 'stream_offline' };
  if (!input.healthy) return { eligible: false, reason: 'integration_unknown' };
  if (input.activeSession) return { eligible: false, reason: 'studio_active' };
  if (input.status === null || input.slots === null)
    return { eligible: false, reason: 'no_resident' };
  if (input.status !== 'ALIVE') return { eligible: false, reason: 'organism_inactive' };
  if (input.slots.reservation !== null)
    return { eligible: false, reason: 'pending_adaptation_exists' };
  return { eligible: true };
}

/** Guards server transitions so a stale deadline or duplicate request cannot move a session. */
export function requireStudioTransition(phase: StudioPhase, event: StudioEvent): StudioPhase {
  const next = nextStudioPhase(phase, event);
  if (next === null)
    throw new StudioRuleError(
      'STUDIO_WRONG_PHASE',
      `Studio cannot apply ${event} during ${phase}.`,
    );
  return next;
}
