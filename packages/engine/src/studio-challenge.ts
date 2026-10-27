import {
  shellDirections,
  studioChallengeSchema,
  type StudioChallenge,
  type StudioMutationTemplate,
} from '@ripple/contracts';
import { applyMove, type Genome, type MutationMove } from './genome.ts';
import { assertCompatibleRuleset, rulesetHash, type Ruleset } from './ruleset.ts';

const shellMoves: Readonly<Record<Exclude<StudioMutationTemplate, 'cosmetic-only'>, MutationMove>> =
  {
    'grit-plus2-pulse-minus2': { from: 'pulse', to: 'grit', amount: 2 },
    'grit-plus2-calm-minus2': { from: 'calm', to: 'grit', amount: 2 },
    'grit-plus2-drift-minus2': { from: 'drift', to: 'grit', amount: 2 },
  };

export function studioMutationMove(template: StudioMutationTemplate): MutationMove | null {
  return template === 'cosmetic-only' ? null : shellMoves[template];
}

export function legalShellTemplates(genome: Genome, rules: Ruleset): StudioMutationTemplate[] {
  const legal = shellDirections.filter(
    (template) => applyMove(genome, shellMoves[template], rules.genome) !== null,
  );
  return legal.length === 0 ? ['cosmetic-only'] : legal;
}

export type ChallengeSnapshot = Omit<
  StudioChallenge,
  'schemaVersion' | 'rulesHash' | 'rendererVersion' | 'mutationTemplateIds'
>;

/** Captures the exact base state; later approval never silently changes its cost. */
export function createStudioChallenge(
  snapshot: ChallengeSnapshot,
  rules: Ruleset,
): StudioChallenge {
  assertCompatibleRuleset(rules);
  return studioChallengeSchema.parse({
    ...snapshot,
    schemaVersion: 1,
    rulesHash: rulesetHash(rules),
    rendererVersion: 'shell-v1',
    mutationTemplateIds: legalShellTemplates(snapshot.genome, rules),
  });
}
