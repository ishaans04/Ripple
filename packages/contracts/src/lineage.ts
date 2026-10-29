import { z } from 'zod';
import { appearanceViewSchema } from './live.ts';
import { studioGenomeSchema } from './studio.ts';

const host = z.object({ channelId: z.uuid(), label: z.string() });
export const lineageNodeSchema = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  founderId: z.uuid(),
  generation: z.int().min(0).max(16),
  name: z.string(),
  genome: studioGenomeSchema,
  health: z.int().min(0).max(100),
  status: z.enum(['ALIVE', 'HARBOR', 'FOSSIL', 'ARCHIVED']),
  appearance: appearanceViewSchema,
  createdAt: z.iso.datetime({ offset: true }),
  lastHost: host
    .extend({
      role: z.enum(['resident', 'visitor', 'harbor']),
      startedAt: z.iso.datetime({ offset: true }),
      endedAt: z.iso.datetime({ offset: true }).nullable(),
    })
    .nullable(),
  birth: z
    .object({
      transferId: z.uuid(),
      source: host,
      destination: host.nullable(),
      outcome: z.string(),
      historical: z.boolean(),
    })
    .nullable(),
  emittedTraces: z.int().nonnegative(),
  latestTrace: z
    .object({
      id: z.uuid(),
      template: z.enum(['charged', 'shelter', 'recovery']),
      status: z.enum(['pending', 'active', 'cleared', 'expired', 'replaced', 'rejected']),
      remainingRounds: z.int().min(0).max(3),
      qualifyingRoundId: z.uuid(),
      host,
    })
    .nullable(),
});
export const lineagePageSchema = z.object({
  schemaVersion: z.literal(1),
  worldId: z.uuid(),
  lineageId: z.uuid(),
  mode: z.enum(['live', 'sandbox', 'replay']),
  origin: host,
  createdAt: z.iso.datetime({ offset: true }),
  rulesHash: z.string().regex(/^[a-f0-9]{64}$/),
  counts: z.object({
    total: z.int().nonnegative(),
    alive: z.int().nonnegative(),
    harbor: z.int().nonnegative(),
    fossil: z.int().nonnegative(),
    archived: z.int().nonnegative(),
  }),
  nodes: z.array(lineageNodeSchema).max(50),
  next: z.string().nullable(),
});
export type LineagePage = z.infer<typeof lineagePageSchema>;
export const lineageCursorSchema = z
  .string()
  .max(80)
  .regex(/^(?:[0-9]|1[0-6]):[0-9a-fA-F-]{36}$/)
  .transform((value) => {
    const [generation, id, extra] = value.split(':');
    return { generation: extra === undefined ? Number(generation) : -1, id };
  })
  .pipe(
    z.strictObject({
      generation: z.int().min(0).max(16),
      id: z.uuid().transform((id) => id.toLowerCase()),
    }),
  );
