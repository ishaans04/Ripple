import { z } from 'zod';
import { displayPreferencesSchema } from './control.ts';

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
export const strainNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine(
    (value) =>
      Array.from(value).every((char) => {
        const code = char.codePointAt(0) ?? 0;
        return (
          code >= 32 &&
          !(code >= 127 && code <= 159) &&
          !(code >= 8234 && code <= 8238) &&
          !(code >= 8294 && code <= 8297)
        );
      }),
    'Control characters are not allowed',
  );
const admissionEligibility = z.strictObject({
  authorized: z.boolean(),
  rulesCompatible: z.boolean(),
});
export const propagationCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('enableMechanics'),
    expectedVersion: z.int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('clearTrace'),
    expectedVersion: z.int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('setTraces'),
    enabled: z.boolean(),
    expectedVersion: z.int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('display'),
    preferences: displayPreferencesSchema,
    expectedVersion: z.int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('raid'),
    transferId: z.uuid(),
    childId: z.uuid(),
    residencyId: z.uuid(),
    arrivalRoundId: z.uuid(),
    destinationChannelId: z.uuid().nullable(),
    destinationTwitchId: z.string().min(1).max(100),
    sourceAuthorized: z.boolean().optional(),
    retainUnenrolled: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal('arrive'),
    transferId: z.uuid(),
    roundId: z.uuid(),
    eligibility: admissionEligibility.optional(),
  }),
  z.strictObject({ type: z.literal('expireAdmission'), transferId: z.uuid() }),
  z.strictObject({
    type: z.literal('claimRaid'),
    transferId: z.uuid(),
    transferVersion: z.int().nonnegative(),
    expectedVersion: z.int().nonnegative().optional(),
    claimantTwitchId: z.string().min(1).max(100).optional(),
    checkedAtMs: z.int().nonnegative().optional(),
    eligibility: admissionEligibility.optional(),
  }),
  z.strictObject({
    type: z.literal('admission'),
    transferId: z.uuid(),
    transferVersion: z.int().nonnegative(),
    decision: z.enum(['accept', 'decline']),
    expectedVersion: z.int().nonnegative().optional(),
    roundId: z.uuid(),
    eligibility: admissionEligibility.optional(),
  }),
  z.strictObject({
    type: z.literal('admissionSweep'),
    roundId: z.uuid(),
    eligibility: admissionEligibility.optional(),
  }),
  z.strictObject({ type: z.literal('prepare'), expectedVersion: z.int().nonnegative().optional() }),
  z.strictObject({
    type: z.literal('blockSource'),
    sourceChannelId: z.uuid(),
    blocked: z.boolean(),
    expectedVersion: z.int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal('blockLineage'),
    lineageId: z.uuid(),
    blocked: z.boolean(),
    expectedVersion: z.int().nonnegative().optional(),
  }),
]);
export type PropagationCommand = z.infer<typeof propagationCommandSchema>;
export const gameCommandSchema = z.discriminatedUnion('type', [
  ...propagationCommandSchema.options,
  z.strictObject({
    type: z.literal('seed'),
    organismId: z.uuid(),
    lineageId: z.uuid(),
    residencyId: z.uuid(),
    roundId: z.uuid(),
    name: strainNameSchema.optional(),
    expectedVersion: z.int().nonnegative().optional(),
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
  z.strictObject({
    type: z.literal('pause'),
    reason: z.enum(['manual', 'offline', 'shutdown']),
    expectedVersion: z.int().nonnegative().optional(),
  }),
  z.strictObject({ type: z.literal('resume'), expectedVersion: z.int().nonnegative().optional() }),
  z.strictObject({ type: z.literal('integration'), online: z.boolean(), healthy: z.boolean() }),
  z.strictObject({ type: z.literal('stream'), online: z.boolean() }),
  z.strictObject({ type: z.literal('inputHealth'), healthy: z.boolean() }),
  z.strictObject({
    type: z.literal('interrupt'),
    reason: z.enum(['input_outage', 'process_gap', 'incompatible_rules']),
  }),
  z.strictObject({ type: z.literal('recover'), expectedVersion: z.int().nonnegative().optional() }),
  z.strictObject({
    type: z.literal('rename'),
    organismId: z.uuid(),
    name: strainNameSchema,
    expectedVersion: z.int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('policy'),
    visitorPolicy: z.enum(['ask', 'accept', 'reject']),
    expectedVersion: z.int().nonnegative(),
  }),
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
  'CLAIM_NOT_AVAILABLE',
  'NOT_CLAIM_DESTINATION',
  'CLAIM_EXPIRED',
  'CLAIM_CAPACITY',
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
