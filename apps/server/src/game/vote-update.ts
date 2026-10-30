import { z } from 'zod';

/** Private durable outbox representation. Gateways still send complete authoritative views. */
export const voteCountsSchema = z.strictObject({
  kind: z.literal('vote-counts-v1'),
  roundId: z.uuid(),
  counts: z.array(z.int().nonnegative()).min(1).max(3),
  studio: z.boolean(),
});
