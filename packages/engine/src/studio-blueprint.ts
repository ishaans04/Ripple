import {
  blueprintSchema,
  MAX_BLUEPRINT_BYTES,
  studioChallengeSchema,
  type AppearanceBlueprint,
  type StudioChallenge,
} from '@ripple/contracts';
import { canonicalJson, sha256Hex } from './canonical.ts';
import { EngineError } from './errors.ts';
import type { Genome } from './genome.ts';
import { rulesetHash, type Ruleset } from './ruleset.ts';
import { legalShellTemplates } from './studio-challenge.ts';

export class StudioRuleError extends Error {
  readonly code:
    | 'INVALID_BLUEPRINT'
    | 'BASE_STATE_CHANGED'
    | 'MUTATION_NOT_LEGAL'
    | 'SLOT_UNAVAILABLE'
    | 'PENDING_ADAPTATION_EXISTS'
    | 'WRONG_WORLD'
    | 'ORGANISM_INACTIVE'
    | 'STUDIO_WRONG_PHASE';
  constructor(code: StudioRuleError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'StudioRuleError';
  }
}

export interface AcceptedBlueprint {
  readonly blueprint: AppearanceBlueprint;
  readonly canonical: string;
  readonly hash: string;
}

/** Strict, bounded input: neither SVG nor arbitrary text ever reaches the renderer. */
export function acceptBlueprint(
  value: unknown,
  challenge: StudioChallenge,
  rules: Ruleset,
): AcceptedBlueprint {
  studioChallengeSchema.parse(challenge);
  const parsed = blueprintSchema.safeParse(value);
  if (!parsed.success)
    throw new StudioRuleError('INVALID_BLUEPRINT', 'The design is outside its supported template.');
  const blueprint = parsed.data;
  const canonical = canonicalJson(blueprint);
  if (new TextEncoder().encode(canonical).length > MAX_BLUEPRINT_BYTES) {
    throw new StudioRuleError('INVALID_BLUEPRINT', 'The design exceeds the payload limit.');
  }
  if (blueprint.worldId !== challenge.worldId)
    throw new StudioRuleError('WRONG_WORLD', 'The design belongs to another world.');
  if (
    blueprint.studioSessionId !== challenge.studioSessionId ||
    blueprint.baseOrganismId !== challenge.baseOrganismId ||
    blueprint.baseOrganismVersion !== challenge.baseOrganismVersion ||
    challenge.rulesHash !== rulesetHash(rules)
  ) {
    throw new StudioRuleError(
      'BASE_STATE_CHANGED',
      'The design does not match the captured challenge.',
    );
  }
  if (
    !challenge.mutationTemplateIds.includes(blueprint.mutationTemplateId) ||
    !legalShellTemplates(challenge.genome, rules).includes(blueprint.mutationTemplateId)
  ) {
    throw new StudioRuleError('MUTATION_NOT_LEGAL', 'This shell trade-off is not available.');
  }
  return Object.freeze({ blueprint, canonical, hash: sha256Hex(canonical) });
}

export function revalidateStudioBase(
  challenge: StudioChallenge,
  current: {
    readonly id: string;
    readonly version: number;
    readonly genome: Genome;
    readonly appearanceHash: string | null;
    readonly status: string;
  },
  rules: Ruleset,
): void {
  if (current.status !== 'ALIVE')
    throw new StudioRuleError('ORGANISM_INACTIVE', 'This branch is no longer alive.');
  if (
    current.id !== challenge.baseOrganismId ||
    current.version !== challenge.baseOrganismVersion ||
    current.appearanceHash !== challenge.baseAppearanceHash ||
    canonicalJson(current.genome) !== canonicalJson(challenge.genome) ||
    challenge.rulesHash !== rulesetHash(rules)
  ) {
    throw new StudioRuleError(
      'BASE_STATE_CHANGED',
      'The organism changed; the approved cost cannot be silently rebased.',
    );
  }
}

/** Canonical JSON errors stay explicit rather than repairing corrupt accepted records. */
export function blueprintHash(value: unknown): string {
  const parsed = blueprintSchema.safeParse(value);
  if (!parsed.success) throw new EngineError('INVALID_ARGUMENT', 'Invalid appearance blueprint');
  return sha256Hex(canonicalJson(parsed.data));
}
