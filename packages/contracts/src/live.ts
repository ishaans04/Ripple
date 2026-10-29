import { z } from 'zod';
import { shellPartSchema, studioGenomeSchema } from './studio.ts';
import { propagationViewSchema, transferViewSchema } from './propagation-view.ts';
export const channelViewSchema = z.object({
  channelId: z.uuid(),
  label: z.string(),
  mode: z.enum(['live', 'sandbox', 'replay']),
  online: z.boolean(),
  healthy: z.boolean(),
  paused: z.boolean(),
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
      candidates: z.array(z.object({ effect: z.string(), tradeOff: z.string() })),
      counts: z.array(z.int().nonnegative()),
      voteCloseAtMs: z.number().nullable(),
      explanation: z.object({ headline: z.string() }).nullable(),
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
