import { founderShell } from '@ripple/contracts';
import { describe, expect, it } from 'vitest';
import { createStudioChallenge } from './studio-challenge.ts';
import { shortlistStudioProposals, resolveStudioSelection } from './studio-selection.ts';
import { candidateRuleset as rules } from './ruleset.ts';

const challenge = createStudioChallenge(
  {
    worldId: '00000000-0000-4000-8000-000000000001',
    studioSessionId: '00000000-0000-4000-8000-000000000002',
    baseOrganismId: '00000000-0000-4000-8000-000000000003',
    baseOrganismVersion: 0,
    genome: rules.genome.founder,
    baseAppearanceHash: null,
    targetMutationSlot: 1,
  },
  rules,
);
const proposals = [
  'grit-plus2-pulse-minus2',
  'grit-plus2-pulse-minus2',
  'grit-plus2-calm-minus2',
].map((mutationTemplateId, i) => ({
  id: `p${i}`,
  artistKey: `a${i}`,
  blueprint: {
    schemaVersion: 1,
    worldId: challenge.worldId,
    studioSessionId: challenge.studioSessionId,
    baseOrganismId: challenge.baseOrganismId,
    baseOrganismVersion: 0,
    rendererVersion: 'shell-v1',
    mutationTemplateId,
    part: founderShell,
  },
}));
describe('studio shortlist and selection', () => {
  it('uses seeded order independent of arrival order and prefers distinct trade-offs', () => {
    const a = shortlistStudioProposals(proposals, challenge, 'recorded-seed', rules);
    expect(
      shortlistStudioProposals([...proposals].reverse(), challenge, 'recorded-seed', rules),
    ).toEqual(a);
    expect(a.finalists).toHaveLength(2);
    expect(new Set(a.finalists.map((item) => item.blueprint.mutationTemplateId)).size).toBe(2);
  });
  it('excludes malformed, duplicate, and unattributed proposals', () => {
    const a = shortlistStudioProposals(
      [
        ...proposals,
        { id: 'bad', artistKey: 'bad', blueprint: {} },
        { ...proposals[0]!, id: 'repeat' },
      ],
      challenge,
      'seed',
      rules,
    );
    expect(a.rejected.map((item) => item.proposalId)).toEqual(['bad', 'repeat']);
  });
  it('keeps current with no eligible proposals or no votes', () => {
    expect(resolveStudioSelection([], []).outcome).toEqual({
      kind: 'keep_current',
      reason: 'no_proposals',
    });
    const { finalists } = shortlistStudioProposals(proposals, challenge, 'seed', rules);
    expect(resolveStudioSelection(finalists, []).outcome).toEqual({
      kind: 'keep_current',
      reason: 'no_votes',
    });
  });
  it('gives a Keep current tie priority and preserves seeded finalist ties', () => {
    const { finalists } = shortlistStudioProposals(proposals, challenge, 'seed', rules);
    expect(
      resolveStudioSelection(finalists, [
        { actorKey: 'a', choice: 1 },
        { actorKey: 'b', choice: 3 },
      ]).outcome.kind,
    ).toBe('keep_current');
    const selected = resolveStudioSelection(finalists, [
      { actorKey: 'a', choice: 1 },
      { actorKey: 'b', choice: 2 },
    ]);
    expect(selected.outcome).toEqual({ kind: 'design', finalist: finalists[0] });
  });
});
