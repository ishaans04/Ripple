import {
  founderShell,
  blueprintSchema,
  rendererVersionSchema,
  type AppearanceBlueprint,
  type ShellPart,
} from '@ripple/contracts';
import { blueprintHash } from './studio-blueprint.ts';
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
  const appearance = parent.appearance;
  if (appearance.kind === 'studio') blueprintSchema.parse(appearance.blueprint);
  else rendererVersionSchema.parse(appearance.rendererVersion);
  return Object.freeze({ genome: Object.freeze({ ...parent.genome }), appearance });
}
