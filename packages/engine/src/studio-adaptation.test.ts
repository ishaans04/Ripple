import { founderShell } from '@ripple/contracts';
import { describe, expect, it } from 'vitest';
import {
  prepareStudioAdaptation,
  commitStudioAdaptation,
  type StudioOrganism,
} from './studio-adaptation.ts';
import { createStudioChallenge } from './studio-challenge.ts';
import { initialMutationSlots, reserveMutationSlot } from './studio-slots.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import { scoreRound } from './scoring.ts';

const current: StudioOrganism = {
  id: '00000000-0000-4000-8000-000000000003',
  version: 0,
  status: 'ALIVE',
  genome: rules.genome.founder,
  appearanceHash: null,
  appearance: null,
};
function prepare(genome = current.genome) {
  const organism = { ...current, genome };
  const challenge = createStudioChallenge(
    {
      worldId: '00000000-0000-4000-8000-000000000001',
      studioSessionId: '00000000-0000-4000-8000-000000000002',
      baseOrganismId: current.id,
      baseOrganismVersion: 0,
      genome,
      baseAppearanceHash: null,
      targetMutationSlot: 1,
    },
    rules,
  );
  const value = {
    schemaVersion: 1,
    worldId: challenge.worldId,
    studioSessionId: challenge.studioSessionId,
    baseOrganismId: current.id,
    baseOrganismVersion: 0,
    rendererVersion: 'shell-v1',
    mutationTemplateId: challenge.mutationTemplateIds[0],
    part: founderShell,
  };
  return {
    organism,
    ...prepareStudioAdaptation(
      'adaptation',
      value,
      challenge,
      organism,
      initialMutationSlots,
      rules,
    ),
  };
}
describe('safe studio hatch', () => {
  it('keeps pending genes unchanged and commits exactly once at the reserved boundary', () => {
    const ready = prepare();
    expect(ready.organism).toEqual(current);
    expect(() => commitStudioAdaptation(ready.pending, current, ready.slots, 2, rules)).toThrow();
    const result = commitStudioAdaptation(ready.pending, current, ready.slots, 1, rules);
    expect(result.organism.genome).toEqual({ pulse: 4, calm: 6, grit: 8, drift: 6 });
    expect(commitStudioAdaptation(ready.pending, result.organism, result.slots, 1, rules)).toEqual({
      outcome: 'already_committed',
      organism: result.organism,
      slots: result.slots,
    });
    expect(() => reserveMutationSlot(result.slots, 'again', 2)).toThrow();
  });
  it('rejects fossils and changed base state without mutation', () => {
    const ready = prepare();
    for (const change of [{ version: 1 }, { status: 'FOSSIL' as const }]) {
      expect(() =>
        commitStudioAdaptation(ready.pending, { ...current, ...change }, ready.slots, 1, rules),
      ).toThrow();
    }
  });
  it('uses the normal slot for a cosmetic hatch and gives it zero fitness effect', () => {
    const ready = prepare({ pulse: 3, calm: 3, grit: 15, drift: 3 });
    const result = commitStudioAdaptation(ready.pending, ready.organism, ready.slots, 1, rules);
    expect(result.organism.genome).toEqual(ready.organism.genome);
    for (const burst of [0, 200, 650, 1000]) {
      const input = {
        healthBefore: 70,
        profile: { burst, steadiness: 1000 - burst },
        shocks: [],
        trace: null,
      };
      expect(scoreRound({ ...input, genome: result.organism.genome }, rules)).toEqual(
        scoreRound({ ...input, genome: ready.organism.genome }, rules),
      );
    }
    expect(result.slots.lastMutation).toBe(1);
  });
});
