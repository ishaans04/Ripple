import { z } from 'zod';
import { channelViewSchema, studioStateSchema } from '@ripple/contracts';

export const judgeSchema = z.object({
  worldId: z.uuid(),
  channelId: z.uuid(),
  neighborId: z.uuid(),
  capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  readCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  neighborReadCapability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type Judge = z.infer<typeof judgeSchema>;
export async function sandboxRequest(
  path: string,
  judge?: Judge,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(judge ? { authorization: `Bearer ${judge.capability}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(value);
    throw new Error(
      failure.success ? failure.data.error.message : `Sandbox request failed (${response.status}).`,
    );
  }
  return value;
}
export async function snapshot(judge: Judge, channelId: string) {
  const response = await fetch(`/api/worlds/${judge.worldId}/snapshot?channelId=${channelId}`, {
    headers: { authorization: `Bearer ${judge.capability}` },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Sandbox expired or unavailable. Reset to start again.');
  return channelViewSchema.parse(
    z.object({ payload: z.unknown() }).parse(await response.json()).payload,
  );
}
export async function studioState(sessionId: string) {
  const response = await fetch(`/api/studios/${sessionId}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('The studio could not be loaded. Refresh to retry.');
  return studioStateSchema.parse(await response.json());
}
export function judgeFromHash(hash: string): Judge | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const parsed = judgeSchema.safeParse(Object.fromEntries(params));
  return parsed.success ? parsed.data : null;
}
export function saveJudge(judge: Judge) {
  history.replaceState(null, '', `/sandbox#${new URLSearchParams(judge).toString()}`);
}
export function readFragment(judge: Judge, channelId: string) {
  return `#${new URLSearchParams({ worldId: judge.worldId, channelId, capability: channelId === judge.channelId ? judge.readCapability : judge.neighborReadCapability }).toString()}`;
}
