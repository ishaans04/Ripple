import { z } from 'zod';

const traceViewSchema = z.object({
  id: z.uuid(),
  version: z.int().nonnegative(),
  emitterId: z.uuid(),
  emitterName: z.string(),
  lineageId: z.uuid(),
  originChannelId: z.uuid(),
  originLabel: z.string(),
  qualifyingRoundId: z.uuid(),
  template: z.enum(['charged', 'shelter', 'recovery']),
  status: z.enum(['pending', 'active', 'cleared', 'expired', 'replaced', 'rejected']),
  remainingRounds: z.int().min(0).max(3),
  choice: z.enum(['keep', 'clear']).nullable(),
  reason: z.string().nullable(),
});
export const mechanicsStateSchema = z.object({
  traceRules: z.object({
    qualifyingRounds: z.int().positive(),
    adjustmentMin: z.int(),
    adjustmentMax: z.int(),
    shelterArrivalShockReduction: z.int().nonnegative(),
    shelterUpkeep: z.int().nonnegative(),
    chargedBurstThreshold: z.int().nonnegative(),
    chargedAdjustment: z.int().nonnegative(),
    recoveryHealthThreshold: z.int().positive(),
    recoveryAdjustment: z.int().nonnegative(),
  }),
  activeTrace: traceViewSchema.nullable(),
  pendingCount: z.int().nonnegative(),
  pendingTraces: z.array(traceViewSchema).max(8),
  recentTraces: z.array(traceViewSchema).max(8),
  dormant: z
    .array(
      z.object({
        id: z.uuid(),
        organismId: z.uuid(),
        organismName: z.string(),
        lineageId: z.uuid(),
        originChannelId: z.uuid(),
        originLabel: z.string(),
        sourceRoundId: z.uuid(),
        template: z.object({
          from: z.enum(['pulse', 'calm', 'grit', 'drift']),
          to: z.enum(['pulse', 'calm', 'grit', 'drift']),
          amount: z.int().positive(),
        }),
        supporters: z.int().nonnegative(),
        totalVotes: z.int().nonnegative(),
        remainingRounds: z.int().min(1).max(3),
        offered: z.boolean(),
        inherited: z.boolean(),
      }),
    )
    .max(5),
});
export type MechanicsState = z.infer<typeof mechanicsStateSchema>;
export type TraceView = z.infer<typeof traceViewSchema>;
