import { z } from 'zod';
import { shellPartSchema, studioGenomeSchema } from './studio.ts';
import { propagationViewSchema, transferViewSchema } from './propagation-view.ts';
import { roundAnalysisSchema } from './analysis.ts';
export const choicePreviewSchema = z
  .object({
    label: z.literal('Based on recent activity'),
    uncertainty: z.literal('Estimate only; future chat, arrivals and category changes may differ.'),
  })
  .and(
    z.discriminatedUnion('status', [
      z.object({
        status: z.literal('learning'),
        reason: z.literal('No valid habitat profile yet'),
        cards: z.tuple([]),
      }),
      z.object({
        status: z.literal('estimate'),
        sourceRoundId: z.uuid(),
        exogenousHash: z.string().regex(/^[a-f0-9]{64}$/),
        cards: z
          .array(
            z.object({
              candidateId: z.string(),
              effect: z.string(),
              tradeOff: z.string(),
              source: z.enum(['generated', 'dormant']),
              estimatedFitness: z.int(),
              estimatedEnergyChange: z.int(),
              relativeToHold: z.int(),
            }),
          )
          .length(3),
      }),
    ]),
  );
export const channelViewSchema = z.object({
  channelId: z.uuid(),
  label: z.string(),
  mode: z.enum(['live', 'sandbox', 'replay']),
  online: z.boolean(),
  healthy: z.boolean(),
  paused: z.boolean(),
  mechanics: z
    .object({
      version: z.union([z.literal(0), z.literal(1)]),
      enableRequested: z.boolean(),
      tracesEnabled: z.boolean(),
    })
    .optional(),
  // Older retained public updates predate propagation; fresh snapshots always include it.
  propagation: propagationViewSchema.optional(),
  organism: z
    .object({
      id: z.uuid(),
      name: z.string(),
      health: z.int().min(0).max(100),
      status: z.string(),
      genome: studioGenomeSchema,
      appearance: z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('founder'),
          rendererVersion: z.string(),
          part: shellPartSchema,
        }),
        z.object({
          kind: z.literal('studio'),
          blueprint: z.object({ rendererVersion: z.string(), part: shellPartSchema }),
        }),
      ]),
    })
    .nullable(),
  round: z
    .object({
      id: z.uuid(),
      number: z.int(),
      kind: z.string().optional(),
      phase: z.string(),
      clock: z.object({
        paused: z.boolean(),
        remainingMs: z.int(),
        deadlineAtMs: z.number().nullable(),
      }),
      candidates: z
        .array(
          z.object({
            effect: z.string(),
            tradeOff: z.string(),
            source: z.enum(['generated', 'dormant']).optional(),
          }),
        )
        .max(3),
      choicePreview: choicePreviewSchema.optional(),
      traceCleared: z
        .object({ id: z.uuid(), sequence: z.int().nonnegative(), reason: z.string() })
        .optional(),
      counts: z.array(z.int().nonnegative()),
      voteCloseAtMs: z.number().nullable(),
      explanation: z.object({ headline: z.string() }).nullable(),
      analysis: roundAnalysisSchema.nullable().optional(),
    })
    .nullable(),
});
export type ChannelView = z.infer<typeof channelViewSchema>;
export const controllerStatusSchema = z.object({
  worldId: z.uuid(),
  channelId: z.uuid(),
  csrfToken: z.string().optional(),
  authorized: z.literal(true),
  botAuthorized: z.boolean(),
  callbackReady: z.boolean(),
  subscriptionsReady: z.boolean(),
  subscriptions: z.array(z.object({ type: z.string(), status: z.string() })),
  settings: z.object({
    input_error: z.string().nullable(),
    visitor_policy: z.enum(['ask', 'accept', 'reject']),
    last_seed_at: z.string().nullable(),
    seed_cooldown_ms: z.int(),
  }),
  snapshot: z.object({ version: z.int(), payload: channelViewSchema }).nullable(),
  readClients: z.int().nonnegative(),
  historicalOffers: z.array(transferViewSchema).max(10).optional(),
});
export type ControllerStatus = z.infer<typeof controllerStatusSchema>;
