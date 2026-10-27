import { z } from 'zod';

export const roundTimingsSchema = z
  .strictObject({
    voteMs: z.int().min(100).max(45_000),
    graceMs: z.int().min(0).max(5_000),
    observationMs: z
      .int()
      .min(120)
      .max(120_000)
      .refine((n) => n % 12 === 0),
    revealMs: z.int().min(0).max(15_000),
  })
  .readonly();
export type RoundTimings = z.infer<typeof roundTimingsSchema>;
export const liveRoundTimings: RoundTimings = Object.freeze({
  voteMs: 45_000,
  graceMs: 1_000,
  observationMs: 120_000,
  revealMs: 14_000,
});

const actorKey = z.string().min(1).max(128);
export const gameCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('seed'),
    organismId: z.uuid(),
    lineageId: z.uuid(),
    residencyId: z.uuid(),
    roundId: z.uuid(),
  }),
  z.strictObject({
    type: z.literal('vote'),
    roundId: z.uuid().optional(),
    actorKey,
    choice: z.int().min(1).max(3),
  }),
  z.strictObject({ type: z.literal('activity'), actorKey }),
  z.strictObject({ type: z.literal('shock'), kind: z.literal('category_change') }),
  z.strictObject({
    type: z.literal('deadline'),
    roundId: z.uuid(),
    revision: z.int().min(0),
    nextRoundId: z.uuid(),
  }),
  z.strictObject({ type: z.literal('pause'), reason: z.enum(['manual', 'offline', 'shutdown']) }),
  z.strictObject({ type: z.literal('resume') }),
  z.strictObject({ type: z.literal('integration'), online: z.boolean(), healthy: z.boolean() }),
  z.strictObject({
    type: z.literal('interrupt'),
    reason: z.enum(['input_outage', 'process_gap', 'incompatible_rules']),
  }),
  z.strictObject({ type: z.literal('recover') }),
]);
export type GameCommand = z.infer<typeof gameCommandSchema>;

export const gameResultCodes = [
  'APPLIED',
  'NO_RESIDENT',
  'RESIDENT_EXISTS',
  'NO_ACTIVE_BALLOT',
  'ALREADY_VOTED',
  'STALE_VERSION',
  'PAUSED',
  'INTEGRATION_UNAVAILABLE',
  'NO_CHANGE',
] as const;
export type GameResultCode = (typeof gameResultCodes)[number];

export const publicUpdateSchema = z.strictObject({
  protocolVersion: z.literal(1),
  eventId: z.uuid(),
  worldId: z.uuid(),
  topic: z.string().regex(/^channel:[0-9a-f-]{36}$/),
  stateVersion: z.int().min(0),
  type: z.string().min(1).max(80),
  serverTime: z.iso.datetime(),
  payload: z.unknown(),
});
export type PublicUpdate = z.infer<typeof publicUpdateSchema>;

export const readScopeSchema = z.strictObject({
  worldId: z.uuid().transform((id) => id.toLowerCase()),
  channelId: z.uuid().transform((id) => id.toLowerCase()),
});
export const connectionTicketSchema = z.strictObject({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
});
