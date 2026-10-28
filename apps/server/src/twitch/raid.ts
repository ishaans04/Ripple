import { z } from 'zod';
const raidEventSchema = z.object({
  from_broadcaster_user_id: z.string().regex(/^[0-9]{1,30}$/),
  to_broadcaster_user_id: z.string().regex(/^[0-9]{1,30}$/),
  viewers: z.int().nonnegative(),
});
/** Viewer count and display names never become health, genes, eligibility or vote weight. */
export function outgoingRaidDestination(value: unknown, sourceTwitchId: string): string | null {
  const event = raidEventSchema.safeParse(value);
  return event.success && event.data.from_broadcaster_user_id === sourceTwitchId
    ? event.data.to_broadcaster_user_id
    : null;
}
export const raidIntentSchema = z.strictObject({
  type: z.literal('twitch.raid'),
  transferId: z.uuid(),
  childId: z.uuid(),
  residencyId: z.uuid(),
  arrivalRoundId: z.uuid(),
  destinationTwitchId: z.string().regex(/^[0-9]{1,30}$/),
});
