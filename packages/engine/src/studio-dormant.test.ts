import { founderShell } from '@ripple/contracts';
import { describe, expect, it } from 'vitest';
import { evaluateDormantBlueprint } from './studio-dormant.ts';
import { candidateRuleset as rules } from './ruleset.ts';

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
describe('dormant design compatibility', () => {
  it('revalidates historical templates and legally rebases only the stored direction', () => {
    expect(evaluateDormantBlueprint(blueprint, rules.genome.founder, 2, rules)).toMatchObject({
      eligible: true,
      genome: { pulse: 4, calm: 6, grit: 8, drift: 6 },
    });
    expect(
      evaluateDormantBlueprint(
        { ...blueprint, rendererVersion: 'unknown' },
        rules.genome.founder,
        2,
        rules,
      ),
    ).toEqual({ eligible: false, reason: 'unsupported_design' });
  });
  it('rejects expired, cosmetic, and illegal alternatives', () => {
    expect(evaluateDormantBlueprint(blueprint, rules.genome.founder, 0, rules).eligible).toBe(
      false,
    );
    expect(
      evaluateDormantBlueprint(
        { ...blueprint, mutationTemplateId: 'cosmetic-only' },
        rules.genome.founder,
        2,
        rules,
      ),
    ).toEqual({ eligible: false, reason: 'cosmetic_only' });
    expect(
      evaluateDormantBlueprint(blueprint, { pulse: 3, calm: 3, grit: 15, drift: 3 }, 2, rules),
    ).toEqual({ eligible: false, reason: 'illegal_rebase' });
  });
});
