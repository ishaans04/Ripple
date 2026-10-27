import fc from 'fast-check';
import { founderShell } from '@ripple/contracts';
import { describe, expect, it } from 'vitest';
import { acceptBlueprint, revalidateStudioBase } from './studio-blueprint.ts';
import { createStudioChallenge } from './studio-challenge.ts';
import { candidateRuleset as rules } from './ruleset.ts';

const snapshot = {
  worldId: '00000000-0000-4000-8000-000000000001',
  studioSessionId: '00000000-0000-4000-8000-000000000002',
  baseOrganismId: '00000000-0000-4000-8000-000000000003',
  baseOrganismVersion: 0,
  genome: rules.genome.founder,
  baseAppearanceHash: null,
  targetMutationSlot: 1,
};
const challenge = createStudioChallenge(snapshot, rules);
const draft = {
  schemaVersion: 1,
  worldId: snapshot.worldId,
  studioSessionId: snapshot.studioSessionId,
  baseOrganismId: snapshot.baseOrganismId,
  baseOrganismVersion: 0,
  mutationTemplateId: 'grit-plus2-pulse-minus2',
  rendererVersion: 'shell-v1',
  part: founderShell,
};
describe('blueprint acceptance', () => {
  it('hashes independent of property insertion order', () => {
    const a = acceptBlueprint(draft, challenge, rules);
    const b = acceptBlueprint(
      Object.fromEntries(Object.entries(draft).reverse()),
      challenge,
      rules,
    );
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects another world, stale base, executable assets, and unoffered mutations', () => {
    for (const change of [
      { worldId: snapshot.studioSessionId },
      { baseOrganismVersion: 1 },
      { svg: '<svg/>' },
      { mutationTemplateId: 'cosmetic-only' },
    ]) {
      expect(() => acceptBlueprint({ ...draft, ...change }, challenge, rules)).toThrow();
    }
  });
  it('validates every generated bounded geometry without changing the cost', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 300, max: 850 }),
        fc.integer({ min: 250, max: 750 }),
        fc.integer({ min: 100, max: 800 }),
        (width, height, curvature) => {
          const accepted = acceptBlueprint(
            { ...draft, part: { ...founderShell, parameters: { width, height, curvature } } },
            challenge,
            rules,
          );
          expect(accepted.blueprint.mutationTemplateId).toBe(draft.mutationTemplateId);
        },
      ),
    );
  });
  it('refuses incompatible current state instead of rebasing an approval', () => {
    const current = {
      id: snapshot.baseOrganismId,
      version: 0,
      genome: snapshot.genome,
      appearanceHash: null,
      status: 'ALIVE',
    };
    expect(() => {
      revalidateStudioBase(challenge, current, rules);
    }).not.toThrow();
    expect(() => {
      revalidateStudioBase(challenge, { ...current, version: 1 }, rules);
    }).toThrow();
    expect(() => {
      revalidateStudioBase(challenge, { ...current, status: 'FOSSIL' }, rules);
    }).toThrow();
  });
});
