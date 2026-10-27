import { blueprintSchema, founderShell, type StudioMutationTemplate } from '@ripple/contracts';
import { describe, expect, it } from 'vitest';
import { evaluateDormantBlueprint, studioDormantFinalist } from './studio-dormant.ts';
import { blueprintHash } from './studio-blueprint.ts';
import type { StudioFinalist } from './studio-selection.ts';
import type { TallyResult } from './tally.ts';
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
  it('captures only a qualified losing direction and preserves the normal vote thresholds', () => {
    const finalist = (
      proposalId: string,
      mutationTemplateId: StudioMutationTemplate,
    ): StudioFinalist => {
      const parsed = blueprintSchema.parse({ ...blueprint, mutationTemplateId });
      return {
        proposalId,
        blueprint: parsed,
        hash: blueprintHash(parsed),
        canonical: JSON.stringify(parsed),
      };
    };
    const winner = finalist('winner', 'grit-plus2-pulse-minus2');
    const loser = finalist('loser', 'grit-plus2-calm-minus2');
    const tally = (counts: number[]): TallyResult => ({
      counts,
      totalVotes: counts.reduce((sum, n) => sum + n, 0),
      winnerIndex: 0,
      ignoredDuplicates: 0,
      ignoredInvalid: 0,
    });
    expect(
      studioDormantFinalist([winner, loser], tally([8, 2, 0]), { ...winner.blueprint }, rules),
    ).toBe(loser);
    for (const counts of [
      [8, 1, 1],
      [18, 2, 0],
      [2, 2, 0],
    ]) {
      expect(
        studioDormantFinalist([winner, loser], tally(counts), winner.blueprint, rules),
      ).toBeNull();
    }
    expect(
      studioDormantFinalist(
        [winner, finalist('same', 'grit-plus2-pulse-minus2')],
        tally([8, 2, 0]),
        winner.blueprint,
        rules,
      ),
    ).toBeNull();
    expect(
      studioDormantFinalist(
        [winner, finalist('cosmetic', 'cosmetic-only')],
        tally([8, 2, 0]),
        winner.blueprint,
        rules,
      ),
    ).toBeNull();
  });
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
