import { z } from 'zod';
import { markHostSchema } from './appearance.ts';

export const FAMILY_DIGEST_LIMIT = 3;
export const familyUpdateKinds = [
  'fossilized',
  'archived',
  'admitted',
  'born',
  'trace_earned',
] as const;
export const familyDigestSchema = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(familyUpdateKinds),
        lineageId: z.uuid(),
        sequence: z.int().positive(),
        organismId: z.uuid(),
        organismName: z.string(),
        generation: z.int().min(0).max(16),
        // Null only when the branch never reached an enrolled host.
        host: markHostSchema.nullable(),
        traceTemplate: z.enum(['charged', 'shelter', 'recovery']).nullable(),
      }),
    )
    .max(FAMILY_DIGEST_LIMIT),
  // Further updates since the last session, available in the lineage map.
  remaining: z.int().nonnegative(),
});
export type FamilyDigest = z.infer<typeof familyDigestSchema>;
