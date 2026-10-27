import { describe, expect, it } from 'vitest';
import { blueprintSchema, founderShell, shellPartSchema } from './studio.ts';

const blueprint = {
  schemaVersion: 1,
  worldId: '00000000-0000-4000-8000-000000000001',
  studioSessionId: '00000000-0000-4000-8000-000000000002',
  baseOrganismId: '00000000-0000-4000-8000-000000000003',
  baseOrganismVersion: 0,
  mutationTemplateId: 'grit-plus2-pulse-minus2',
  rendererVersion: 'shell-v1',
  part: founderShell,
};
describe('declarative studio contract', () => {
  it('accepts only bounded integer parameters and supported versions', () => {
    expect(blueprintSchema.safeParse(blueprint).success).toBe(true);
    for (const width of [299, 851, 620.5, NaN, Infinity]) {
      expect(
        shellPartSchema.safeParse({
          ...founderShell,
          parameters: { ...founderShell.parameters, width },
        }).success,
      ).toBe(false);
    }
    expect(blueprintSchema.safeParse({ ...blueprint, rendererVersion: 'unknown' }).success).toBe(
      false,
    );
  });
  it('rejects executable content, identities, and authoritative game fields', () => {
    for (const extra of [
      { svg: '<svg onload="alert(1)"/>' },
      { health: 100 },
      { artistId: 'forged' },
      { genes: [0, 0, 15, 9] },
    ]) {
      expect(blueprintSchema.safeParse({ ...blueprint, ...extra }).success).toBe(false);
    }
    expect(
      shellPartSchema.safeParse({
        ...founderShell,
        marking: { patternId: '<script>', paletteId: 'teal-amber' },
      }).success,
    ).toBe(false);
  });
  it('freezes the accepted design at every object level', () => {
    const parsed = blueprintSchema.parse(blueprint);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.part.parameters)).toBe(true);
    expect(Object.isFrozen(parsed.part.marking)).toBe(true);
  });
});
