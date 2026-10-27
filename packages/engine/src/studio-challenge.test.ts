import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyMove, isLegalGenome, type Genome } from './genome.ts';
import { candidateRuleset as rules } from './ruleset.ts';
import {
  createStudioChallenge,
  legalShellTemplates,
  studioMutationMove,
} from './studio-challenge.ts';

export const studioSnapshot = {
  worldId: '00000000-0000-4000-8000-000000000001',
  studioSessionId: '00000000-0000-4000-8000-000000000002',
  baseOrganismId: '00000000-0000-4000-8000-000000000003',
  baseOrganismVersion: 0,
  genome: rules.genome.founder,
  baseAppearanceHash: null,
  targetMutationSlot: 1,
};
describe('studio challenge', () => {
  it('captures base version, legal costs, rules hash, and slot', () => {
    expect(createStudioChallenge(studioSnapshot, rules)).toMatchObject({
      ...studioSnapshot,
      rendererVersion: 'shell-v1',
      mutationTemplateIds: [
        'grit-plus2-pulse-minus2',
        'grit-plus2-calm-minus2',
        'grit-plus2-drift-minus2',
      ],
    });
  });
  it('offers cosmetic-only instead of bypassing gene bounds', () => {
    expect(legalShellTemplates({ pulse: 3, calm: 3, grit: 15, drift: 3 }, rules)).toEqual([
      'cosmetic-only',
    ]);
  });
  it('conserves the budget for every direction of every generated legal genome', () => {
    fc.assert(
      fc.property(fc.tuple(fc.nat(15), fc.nat(15), fc.nat(15)), ([pulse, calm, grit]) => {
        const genome: Genome = { pulse, calm, grit, drift: 24 - pulse - calm - grit };
        fc.pre(isLegalGenome(genome, rules.genome));
        for (const template of legalShellTemplates(genome, rules)) {
          const move = studioMutationMove(template);
          const next = move === null ? genome : applyMove(genome, move, rules.genome);
          expect(next).not.toBeNull();
          expect(Object.values(next!).reduce((sum, n) => sum + n, 0)).toBe(24);
        }
      }),
    );
  });
});
