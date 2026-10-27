import { founderShell, type AppearanceBlueprint } from '@ripple/contracts';
import { describe, expect, it } from 'vitest';
import {
  committedStudioAppearance,
  founderAppearance,
  inheritCommittedDesign,
} from './studio-inheritance.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import { blueprintHash } from './studio-blueprint.ts';

const blueprint: AppearanceBlueprint = {
  schemaVersion: 1,
  worldId: '00000000-0000-4000-8000-000000000001',
  studioSessionId: '00000000-0000-4000-8000-000000000002',
  baseOrganismId: '00000000-0000-4000-8000-000000000003',
  baseOrganismVersion: 0,
  mutationTemplateId: 'grit-plus2-pulse-minus2',
  rendererVersion: 'shell-v1',
  part: founderShell,
};
describe('committed appearance inheritance', () => {
  it('provides a neutral unattributed founder appearance', () => {
    expect(founderAppearance).toEqual({
      kind: 'founder',
      rendererVersion: 'shell-v1',
      part: founderShell,
    });
  });
  it('snapshots committed genes and appearance, ignoring pending designs and later parent hatches', () => {
    const parent = {
      genome: { ...rules.genome.founder },
      appearance: founderAppearance,
      pending: blueprint,
    };
    const child = inheritCommittedDesign(parent);
    parent.genome.pulse = 4;
    parent.appearance = committedStudioAppearance(blueprint, null, 'Origin channel', null);
    expect(child.genome.pulse).toBe(6);
    expect(child.appearance.kind).toBe('founder');
    expect('pending' in child).toBe(false);
    const later = inheritCommittedDesign(parent);
    expect(later.appearance).toEqual(parent.appearance);
  });
  it('publishes channel credit by default and individual credit only with opt-in', () => {
    expect(
      committedStudioAppearance(blueprint, null, 'Channel', { optedIn: false, credit: 'Artist' }),
    ).toMatchObject({ channelCredit: 'Channel', artistCredit: null });
    expect(
      committedStudioAppearance(blueprint, null, 'Channel', { optedIn: true, credit: 'Artist' }),
    ).toMatchObject({ artistCredit: 'Artist' });
  });
  it('deeply snapshots designs loaded from mutable storage records', () => {
    const mutable = {
      ...blueprint,
      part: { ...founderShell, parameters: { ...founderShell.parameters } },
    };
    const child = inheritCommittedDesign({
      genome: rules.genome.founder,
      appearance: {
        kind: 'studio',
        hash: blueprintHash(mutable),
        blueprint: mutable,
        parentHash: null,
        channelCredit: 'Channel',
        artistCredit: null,
      },
    });
    mutable.part.parameters.width = 800;
    expect(
      child.appearance.kind === 'studio' && child.appearance.blueprint.part.parameters.width,
    ).toBe(620);
  });
});
