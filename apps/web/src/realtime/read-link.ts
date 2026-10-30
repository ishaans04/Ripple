import { z } from 'zod';

const readLinkSchema = z.strictObject({
  worldId: z.uuid(),
  channelId: z.uuid(),
  capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type ReadLink = z.infer<typeof readLinkSchema>;

/** Read capabilities stay in the URL fragment and are only sent as authorization headers. */
export function readLinkFromHash(hash: string): ReadLink | null {
  const parsed = readLinkSchema.safeParse(Object.fromEntries(new URLSearchParams(hash.slice(1))));
  return parsed.success ? parsed.data : null;
}
