import { z } from 'zod';

const version = { expectedVersion: z.int().nonnegative() };
/** Owner requests carry versions, never eligibility flags or generated game identifiers. */
export const channelControlSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('enableMechanics'), ...version }),
  z.strictObject({ action: z.literal('clearTrace'), ...version }),
  z.strictObject({ action: z.literal('setTraces'), enabled: z.boolean(), ...version }),
  z.strictObject({ action: z.literal('prepare'), ...version }),
  z.strictObject({
    action: z.literal('claimRaid'),
    ...version,
    transferId: z.uuid(),
    transferVersion: z.int().nonnegative(),
  }),
  z.strictObject({
    action: z.literal('admission'),
    ...version,
    transferId: z.uuid(),
    transferVersion: z.int().nonnegative(),
    decision: z.enum(['accept', 'decline']),
  }),
  z.strictObject({
    action: z.literal('blockSource'),
    ...version,
    sourceChannelId: z.uuid(),
    blocked: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('blockLineage'),
    ...version,
    lineageId: z.uuid(),
    blocked: z.boolean(),
  }),
]);
export type ChannelControl = z.infer<typeof channelControlSchema>;
export const blocksPageSchema = z.object({
  kind: z.enum(['source', 'lineage']),
  items: z.array(z.object({ id: z.uuid(), label: z.string() })).max(50),
  next: z.uuid().nullable(),
});
export type BlocksPage = z.infer<typeof blocksPageSchema>;
