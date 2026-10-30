import { z } from 'zod';
import { channelViewSchema, founderShell, studioStateSchema } from '@ripple/contracts';
import { performance } from 'node:perf_hooks';

const judgeSchema = z.object({
  worldId: z.uuid(),
  channelId: z.uuid(),
  neighborId: z.uuid(),
  capability: z.string(),
  readCapability: z.string(),
  neighborReadCapability: z.string(),
});
const started = performance.now();
const base = process.env.JUDGE_BASE_URL ?? 'http://127.0.0.1:3000';
async function request(path: string, capability?: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(capability ? { authorization: `Bearer ${capability}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return await response.json();
}
const judge = judgeSchema.parse(await request('/api/sandbox'));
const act = (action: string, fields: Record<string, unknown> = {}, channelId = judge.channelId) =>
  request(`/api/sandbox/${judge.worldId}/actions`, judge.capability, {
    action,
    channelId,
    ...fields,
  });
async function view(channelId = judge.channelId) {
  const response = await fetch(
    `${base}/api/worlds/${judge.worldId}/snapshot?channelId=${channelId}`,
    {
      headers: {
        authorization: `Bearer ${channelId === judge.channelId ? judge.readCapability : judge.neighborReadCapability}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
  return channelViewSchema.parse(
    z.object({ payload: z.unknown() }).parse(await response.json()).payload,
  );
}
await act('vote', { choice: 1, crowd: true });
await act('next');
await act('chat', { accounts: 3 });
await act('shock');
await act('next');
if (!(await view()).round?.analysis) throw new Error('Missing resolved round analysis');
await act('raid', { destinationId: judge.neighborId });
await act('next', {}, judge.neighborId);
await act('next', {}, judge.neighborId);
if (!(await view(judge.neighborId)).propagation?.visitor) throw new Error('Missing raid visitor');
await act('next');
await act('studioStart');
const sessionId = (await view()).studio?.session?.id;
if (!sessionId) throw new Error('No open studio');
const state = studioStateSchema.parse(
  await (await fetch(`${base}/api/studios/${sessionId}`)).json(),
);
const challenge = state.challenge;
if (!challenge) throw new Error('No studio challenge');
await act('propose', {
  creditOptIn: true,
  inputMode: 'pointer',
  blueprint: {
    schemaVersion: 1,
    worldId: challenge.worldId,
    studioSessionId: sessionId,
    baseOrganismId: challenge.baseOrganismId,
    baseOrganismVersion: challenge.baseOrganismVersion,
    mutationTemplateId: challenge.mutationTemplateIds[0],
    rendererVersion: 'shell-v1',
    part: { ...founderShell, parameters: { ...founderShell.parameters, width: 800 } },
  },
});
await act('next');
await act('vote', { choice: 1, crowd: true });
await act('next');
await act('review', { decision: 'approve' });
for (let step = 0; step < 6 && (await view()).studio?.session?.phase !== 'COMPLETED'; step++)
  await act('next');
if ((await view()).organism?.appearance.kind !== 'studio') throw new Error('Design did not hatch');
const replay = z
  .object({ sourceComparison: z.array(z.object({ equal: z.boolean() })).min(2) })
  .parse(await request(`/api/sandbox/${judge.worldId}/replay`, judge.capability));
if (!replay.sourceComparison.every((item) => item.equal)) throw new Error('Replay diverged');
const fresh = judgeSchema.parse(
  await request(`/api/sandbox/${judge.worldId}/reset`, judge.capability),
);
if (fresh.worldId === judge.worldId) throw new Error('Reset reused the old world');
const elapsedMs = Math.round(performance.now() - started);
if (elapsedMs >= 180_000) throw new Error(`Judge journey exceeded three minutes: ${elapsedMs}ms`);
process.stdout.write(
  `${JSON.stringify({ synthetic: true, journey: 'mutation-observation-raid-studio-hatch-replay-reset', elapsedMs, channelsCompared: replay.sourceComparison.length, replayDivergences: 0 })}\n`,
);
