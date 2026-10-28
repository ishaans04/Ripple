import { z } from 'zod';

const ancestry = {
  id: z.uuid(),
  lineageId: z.uuid(),
  parentId: z.uuid().nullable(),
  originChannelId: z.uuid(),
  originLabel: z.string(),
  generation: z.int().nonnegative(),
  livingBranches: z.int().nonnegative(),
};
export const transferViewSchema = z.object({
  id: z.uuid(),
  version: z.int().nonnegative(),
  outcome: z.string(),
  childId: z.uuid().nullable(),
  lineageId: z.uuid().nullable(),
  sourceChannelId: z.uuid(),
  sourceLabel: z.string(),
  destinationChannelId: z.uuid().nullable(),
  destinationLabel: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});
export const propagationViewSchema = z.object({
  preparation: z.enum(['shield', 'reserve', 'neutral']),
  preparationRequested: z.boolean(),
  resident: z.object(ancestry).nullable(),
  visitor: z
    .object({
      ...ancestry,
      name: z.string(),
      health: z.int().min(0).max(100),
      welcomed: z.boolean(),
      arrivalPending: z.boolean(),
      shockReduction: z.int().nonnegative(),
      shelterPending: z.boolean(),
    })
    .nullable(),
  admissions: z.array(transferViewSchema).max(4),
  outgoing: z.array(transferViewSchema).max(10),
  limits: z.object({
    livingLineageCap: z.int().positive(),
    harborCap: z.int().positive(),
    generationCap: z.int().positive(),
    forkCooldownMs: z.int().positive(),
    admissionTtlMs: z.int().positive(),
  }),
  lastContest: z
    .object({
      roundId: z.uuid(),
      visitorId: z.uuid(),
      outcome: z.enum(['held', 'empty', 'visitor', 'resident', 'sheltered']),
      moved: z.int().nonnegative(),
      residentHealth: z.int().min(0).max(100).nullable(),
      visitorHealth: z.int().min(0).max(100),
    })
    .nullable(),
});
export type PropagationView = z.infer<typeof propagationViewSchema>;
