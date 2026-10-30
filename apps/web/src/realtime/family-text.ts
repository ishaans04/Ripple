import type { FamilyDigest } from '@ripple/contracts';
import { traceTitle } from './trace-labels.ts';

type FamilyUpdate = FamilyDigest['items'][number];

/** One plain sentence per structural update; names are rendered as text, never markup. */
export function familyUpdateText(update: FamilyUpdate): string {
  const who = `${update.organismName} (generation ${update.generation})`,
    at = update.host === null ? '' : ` at ${update.host.label}`;
  switch (update.kind) {
    case 'fossilized':
      return `${who} became a fossil${at}`;
    case 'archived':
      return `${who} ended before admission${at}`;
    case 'admitted':
      return `${who} was admitted${at}`;
    case 'born':
      return `${who} was born from a raid${update.host === null ? '' : ` by ${update.host.label}`}`;
    case 'trace_earned':
      return `${who} earned a ${update.traceTemplate === null ? 'habitat' : traceTitle[update.traceTemplate]} trace${at}`;
  }
}

export function familyRemainingText(digest: FamilyDigest): string | null {
  return digest.remaining === 0
    ? null
    : `${digest.remaining} more family update${digest.remaining === 1 ? '' : 's'} in the lineage map`;
}
