import { z } from 'zod';

const version = { expectedVersion: z.int().nonnegative() };
/** Owner requests carry versions, never eligibility flags or generated game identifiers. */
export const channelControlSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('prepare'), ...version }),
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
]);
export type ChannelControl = z.infer<typeof channelControlSchema>;
