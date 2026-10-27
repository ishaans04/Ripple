import type { AppearanceBlueprint, StudioChallenge } from '@ripple/contracts';
import { applyMove, type Genome } from './genome.ts';
import type { Ruleset } from './ruleset.ts';
import {
  acceptBlueprint,
  revalidateStudioBase,
  StudioRuleError,
  type AcceptedBlueprint,
} from './studio-blueprint.ts';
import { studioMutationMove } from './studio-challenge.ts';
import { consumeMutationSlot, reserveMutationSlot, type MutationSlots } from './studio-slots.ts';

export interface StudioOrganism {
  readonly id: string;
  readonly version: number;
  readonly genome: Genome;
  readonly status: 'ALIVE' | 'HARBOR' | 'FOSSIL' | 'ARCHIVED';
  readonly appearanceHash: string | null;
  readonly appearance: AppearanceBlueprint | null;
}
export interface PendingAdaptation {
  readonly id: string;
  readonly challenge: StudioChallenge;
  readonly design: AcceptedBlueprint;
}

export function prepareStudioAdaptation(
  id: string,
  value: unknown,
  challenge: StudioChallenge,
  current: StudioOrganism,
  slots: MutationSlots,
  rules: Ruleset,
): {
  readonly pending: PendingAdaptation;
  readonly slots: MutationSlots;
} {
  revalidateStudioBase(challenge, current, rules);
  const design = acceptBlueprint(value, challenge, rules);
  return {
    pending: { id, challenge, design },
    slots: reserveMutationSlot(slots, id, challenge.targetMutationSlot),
  };
}

/** The persistence worker will atomically save this result before publishing a hatch. */
export function commitStudioAdaptation(
  pending: PendingAdaptation,
  current: StudioOrganism,
  slots: MutationSlots,
  boundarySlot: number,
  rules: Ruleset,
): {
  readonly outcome: 'committed' | 'already_committed';
  readonly organism: StudioOrganism;
  readonly slots: MutationSlots;
} {
  const { challenge, design, id } = pending;
  const previous = slots.commitments.find((entry) => entry.operationId === id);
  if (previous !== undefined) {
    if (previous.slot !== challenge.targetMutationSlot || previous.fingerprint !== design.hash)
      throw new StudioRuleError('SLOT_UNAVAILABLE', 'Conflicting adaptation retry.');
    return { outcome: 'already_committed', organism: current, slots };
  }
  revalidateStudioBase(challenge, current, rules);
  const accepted = acceptBlueprint(design.blueprint, challenge, rules);
  if (accepted.hash !== design.hash)
    throw new StudioRuleError('INVALID_BLUEPRINT', 'Accepted design hash changed.');
  if (boundarySlot !== challenge.targetMutationSlot || slots.reservation?.adaptationId !== id) {
    throw new StudioRuleError(
      'SLOT_UNAVAILABLE',
      'The adaptation must wait for its reserved mutation boundary.',
    );
  }
  const move = studioMutationMove(accepted.blueprint.mutationTemplateId);
  const genome = move === null ? current.genome : applyMove(current.genome, move, rules.genome);
  if (genome === null)
    throw new StudioRuleError('MUTATION_NOT_LEGAL', 'The approved trade-off is no longer legal.');
  return {
    outcome: 'committed',
    organism: {
      ...current,
      genome: Object.freeze({ ...genome }),
      version: current.version + 1,
      appearanceHash: accepted.hash,
      appearance: accepted.blueprint,
    },
    slots: consumeMutationSlot(slots, id, boundarySlot, accepted.hash),
  };
}
