import { z } from 'zod';

const version = { expectedVersion: z.int().nonnegative() };
/** Broadcaster display choices. They change presentation only, never game state or history. */
export const displayPreferencesSchema = z
  .strictObject({
    layout: z.enum(['compact', 'expanded']),
    reducedMotion: z.boolean(),
    familyNews: z.boolean(),
    celebrations: z.boolean(),
  })
  .readonly();
export type DisplayPreferences = z.infer<typeof displayPreferencesSchema>;
export const defaultDisplayPreferences: DisplayPreferences = {
  layout: 'compact',
  reducedMotion: false,
  familyNews: true,
  celebrations: true,
};
/** Optional paid-event celebrations: presentation only, never fitness, votes or survival. */
export const celebrationKinds = ['cheer', 'subscription', 'hype_train'] as const;
export const celebrationSchema = z.object({
  kind: z.enum(celebrationKinds),
  atMs: z.number().int().nonnegative(),
});
export type Celebration = z.infer<typeof celebrationSchema>;
// At most one visible celebration per minute of channel time, whatever the amount or count.
export const CELEBRATION_COOLDOWN_MS = 60_000;
export const CELEBRATION_VISIBLE_MS = 8_000;
/** Owner requests carry versions, never eligibility flags or generated game identifiers. */
export const channelControlSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('enableMechanics'), ...version }),
  z.strictObject({ action: z.literal('clearTrace'), ...version }),
  z.strictObject({ action: z.literal('setTraces'), enabled: z.boolean(), ...version }),
  z.strictObject({ action: z.literal('prepare'), ...version }),
  z.strictObject({
    action: z.literal('display'),
    preferences: displayPreferencesSchema,
    ...version,
  }),
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
