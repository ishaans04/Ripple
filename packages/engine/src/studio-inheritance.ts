import {
  founderShell,
  blueprintSchema,
  rendererVersionSchema,
  shellPartSchema,
  type AppearanceBlueprint,
  type ShellPart,
} from '@ripple/contracts';
import { blueprintHash, StudioRuleError } from './studio-blueprint.ts';
import type { Genome } from './genome.ts';

export type CommittedAppearance =
  | { readonly kind: 'founder'; readonly rendererVersion: 'shell-v1'; readonly part: ShellPart }
  | {
      readonly kind: 'studio';
      readonly hash: string;
      readonly blueprint: AppearanceBlueprint;
      readonly parentHash: string | null;
      readonly channelCredit: string;
      readonly artistCredit: string | null;
    };

export const founderAppearance: CommittedAppearance = Object.freeze({
  kind: 'founder',
  rendererVersion: 'shell-v1',
  part: founderShell,
});

export function committedStudioAppearance(
  blueprint: AppearanceBlueprint,
  parentHash: string | null,
  channelCredit: string,
  artist: { readonly optedIn: boolean; readonly credit: string } | null,
): CommittedAppearance {
  const parsed = blueprintSchema.parse(blueprint);
  return Object.freeze({
    kind: 'studio',
    hash: blueprintHash(parsed),
    blueprint: parsed,
    parentHash,
    channelCredit,
    artistCredit: artist?.optedIn === true ? artist.credit : null,
  });
}

/** Explicitly accepts only committed state. Pending art is not an inheritance input. */
export function inheritCommittedDesign(parent: {
  readonly genome: Genome;
  readonly appearance: CommittedAppearance;
}): { readonly genome: Genome; readonly appearance: CommittedAppearance } {
  const source = parent.appearance;
  let appearance: CommittedAppearance;
  if (source.kind === 'studio') {
    const blueprint = blueprintSchema.parse(source.blueprint);
    if (blueprintHash(blueprint) !== source.hash)
      throw new StudioRuleError(
        'INVALID_BLUEPRINT',
        'Committed appearance hash does not match its design.',
      );
    appearance = Object.freeze({ ...source, blueprint });
  } else {
    rendererVersionSchema.parse(source.rendererVersion);
    appearance = Object.freeze({ ...source, part: shellPartSchema.parse(source.part) });
  }
  return Object.freeze({ genome: Object.freeze({ ...parent.genome }), appearance });
}
