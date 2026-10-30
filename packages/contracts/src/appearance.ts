import { z } from 'zod';
import { studioGenomeSchema } from './studio.ts';

/**
 * Appearance mapping versions are persisted per organism. A new mapping adds a new version;
 * existing organisms and fossils keep rendering with the version they were created under.
 */
export const APPEARANCE_MAPPING_VERSION = 1;
export const appearanceMappingVersionSchema = z.literal(APPEARANCE_MAPPING_VERSION);
export type AppearanceMappingVersion = z.infer<typeof appearanceMappingVersionSchema>;

export const movementVariants = ['settled', 'sway', 'quick'] as const;
export const platingVariants = ['smooth', 'ridged', 'armored'] as const;
export const appendageVariants = ['stubs', 'fins', 'streamers'] as const;
export interface GeneAppearance {
  readonly movement: (typeof movementVariants)[number];
  readonly plating: (typeof platingVariants)[number];
  readonly appendages: (typeof appendageVariants)[number];
}

function band<T>(value: number, variants: readonly [T, T, T]): T {
  return value <= 4 ? variants[0] : value <= 9 ? variants[1] : variants[2];
}

/**
 * Version 1: Pulse against Calm sets movement, Grit sets shell plating and Drift sets
 * appendages. Shell geometry and markings stay with the committed founder or studio design.
 */
export function geneAppearance(
  genome: { pulse: number; calm: number; grit: number; drift: number },
  version: AppearanceMappingVersion,
): GeneAppearance {
  appearanceMappingVersionSchema.parse(version);
  const { pulse, calm, grit, drift } = studioGenomeSchema.parse(genome);
  const tempo = pulse - calm;
  return {
    movement: tempo >= 4 ? 'quick' : tempo <= -4 ? 'settled' : 'sway',
    plating: band(grit, platingVariants),
    appendages: band(drift, appendageVariants),
  };
}

export const markHostSchema = z.object({ channelId: z.uuid(), label: z.string() });
export type MarkHost = z.infer<typeof markHostSchema>;
export const appearanceMarksSchema = z.object({
  origin: markHostSchema,
  ancestry: z.array(markHostSchema).max(2),
});
export type AppearanceMarks = z.infer<typeof appearanceMarksSchema>;

/**
 * Stable mark policy: the lineage origin is always kept. Of the hosts the ancestry chain was
 * actually admitted to (in first-admission order, origin excluded), keep the first divergence
 * from the origin and the most recent host. The passport keeps the full host history.
 */
export function ancestryMarks(origin: MarkHost, hostsInAdmissionOrder: readonly MarkHost[]) {
  const seen = new Set<string>();
  for (const item of hostsInAdmissionOrder) {
    const key = item.channelId.toLowerCase();
    if (seen.has(key)) throw new Error('Host history must list each channel once.');
    seen.add(key);
  }
  const visited = hostsInAdmissionOrder.filter(
    (item) => item.channelId.toLowerCase() !== origin.channelId.toLowerCase(),
  );
  const ancestry = visited.length <= 2 ? visited : [visited[0], visited[visited.length - 1]];
  return appearanceMarksSchema.parse({ origin, ancestry });
}

export const markGlyphShapes = ['ring', 'chevron', 'triad', 'bar', 'diamond', 'wave'] as const;
export const markGlyphTones = ['teal', 'amber', 'coral', 'moss'] as const;
const markGlyphSchema = z.object({ shape: z.enum(markGlyphShapes), tone: z.enum(markGlyphTones) });
export type MarkGlyph = z.infer<typeof markGlyphSchema>;

/** FNV-1a over the canonical lowercase channel UUID; the label always accompanies the glyph. */
export function markGlyph(channelId: string): MarkGlyph {
  const canonical = z.uuid().parse(channelId).toLowerCase();
  let hash = 0x811c9dc5;
  for (const character of canonical) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return markGlyphSchema.parse({
    shape: markGlyphShapes[hash % markGlyphShapes.length],
    tone: markGlyphTones[(hash >>> 8) % markGlyphTones.length],
  });
}
