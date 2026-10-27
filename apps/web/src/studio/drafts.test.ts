import { founderShell, type AppearanceBlueprint } from '@ripple/contracts';
import { candidateRuleset, createStudioChallenge } from '@ripple/engine';
import { describe, expect, it } from 'vitest';
import { loadDraft, saveDraft, type DraftStorage } from './drafts.ts';

const challenge = createStudioChallenge(
  {
    worldId: '00000000-0000-4000-8000-000000000001',
    studioSessionId: '00000000-0000-4000-8000-000000000002',
    baseOrganismId: '00000000-0000-4000-8000-000000000003',
    baseOrganismVersion: 0,
    genome: candidateRuleset.genome.founder,
    baseAppearanceHash: null,
    targetMutationSlot: 1,
  },
  candidateRuleset,
);
const blueprint: AppearanceBlueprint = {
  schemaVersion: 1,
  worldId: challenge.worldId,
  studioSessionId: challenge.studioSessionId,
  baseOrganismId: challenge.baseOrganismId,
  baseOrganismVersion: 0,
  mutationTemplateId: 'grit-plus2-pulse-minus2',
  rendererVersion: 'shell-v1',
  part: founderShell,
};
function storage(): DraftStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}
describe('private local draft recovery', () => {
  it('recovers a bounded draft only in its matching challenge and lifetime', () => {
    const disk = storage();
    expect(saveDraft(disk, blueprint, challenge, 1000)).toBe(true);
    expect(loadDraft(disk, challenge, 2000)).toEqual(blueprint);
    expect(loadDraft(disk, { ...challenge, baseOrganismVersion: 1 }, 2000)).toBeNull();
    expect(loadDraft(disk, challenge, 1000 + 8 * 24 * 3600000)).toBeNull();
  });
  it('handles malformed storage and denied writes without losing the in-memory draft', () => {
    const disk: DraftStorage = {
      getItem: () => '{bad',
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(loadDraft(disk, challenge, 1)).toBeNull();
    expect(saveDraft(disk, blueprint, challenge, 1)).toBe(false);
    expect(blueprint.part).toEqual(founderShell);
  });
});
