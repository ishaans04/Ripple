import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { channelViewSchema, publicUpdateSchema, studioStateSchema } from '@ripple/contracts';

/**
 * Installed synthetic studio journey: break, two artists, chat selection, review, hatch, and a
 * raid descendant carrying the design, plus the public studio and bridge HTTP boundaries. Every
 * action runs in an isolated synthetic world; it is not live Twitch or OBS evidence.
 */
const ownPath = fileURLToPath(import.meta.url),
  entry = join(dirname(ownPath), `sandbox${extname(ownPath)}`);
function run(args: string[], owner?: string): unknown {
  return JSON.parse(
    execFileSync(process.execPath, [...process.execArgv, entry, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...(owner === undefined ? {} : { RIPPLE_SANDBOX_CAPABILITY: owner }) },
    }),
  ) as unknown;
}
const created = z
  .object({ worldId: z.uuid(), channelId: z.uuid(), ownerCapability: z.string() })
  .parse(run(['create']));
function command(name: string, channelId: string, ...args: string[]) {
  return z
    .object({ snapshot: publicUpdateSchema, result: z.unknown().optional() })
    .parse(run([name, created.worldId, channelId, ...args], created.ownerCapability));
}
function status(channelId = created.channelId) {
  return channelViewSchema.parse(command('status', channelId).snapshot.payload);
}
const advance = (ms: number) => command('advance', created.channelId, String(ms));
const base = new URL(
  process.env.RIPPLE_SMOKE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`,
);

command(
  'studio-settings',
  created.channelId,
  JSON.stringify({
    creationMs: 10_000,
    votingMs: 10_000,
    breakScenes: ['BRB'],
    activeScenes: ['Live'],
  }),
);
// The break arrives from a configured OBS scene through the ordered worker.
command('bridge-scene', created.channelId, 'BRB');
let view = status();
const session = view.studio?.session;
assert.equal(session?.phase, 'CREATING');
assert.equal(view.round?.clock.paused, true);
const studio = studioStateSchema.parse(
  await (await fetch(new URL(`/api/studios/${session.id}`, base))).json(),
);
assert.equal(studio.challenge?.studioSessionId, session.id);
command('studio-propose', created.channelId, 'ana', '0', '760');
command('studio-propose', created.channelId, 'ben', '1', '420');
advance(10_000);
view = status();
assert.equal(view.studio?.session?.phase, 'VOTING');
assert.equal(view.studio.session.finalists.length, 2);
const winner = view.studio.session.finalists.find((item) => item.credit === 'synthetic-ana');
assert.ok(winner !== undefined);
const blueprint = await fetch(new URL(`/api/blueprints/${winner.hash}?studio=${session.id}`, base));
assert.equal(blueprint.status, 200);
for (let i = 0; i < 3; i++) command('vote', created.channelId, `ana-${i}`, String(winner.index));
command('vote', created.channelId, 'ben-0', String(3 - winner.index));
advance(10_000);
assert.equal(status().studio?.session?.phase, 'REVIEW');
command('studio-review', created.channelId, 'approve');
view = status();
assert.equal(view.studio?.session?.phase, 'PENDING_HATCH');
assert.equal(view.organism?.appearance.kind, 'founder');
const before = view.organism.genome;
advance(3_200);
view = status();
assert.equal(view.studio?.session?.phase, 'COMPLETED');
assert.equal(view.organism?.appearance.kind, 'studio');
assert.equal(view.organism.genome.grit, before.grit + 2);
// Repeating the same break scene now opens a fresh studio, not a second change to this slot.
command('bridge-scene', created.channelId, 'Live');
const peer = z
  .object({ channelId: z.uuid() })
  .parse(command('peer', created.channelId, 'Studio raid host', randomUUID()).result);
command('policy', peer.channelId, 'accept');
command('raid', created.channelId, peer.channelId, randomUUID());
const host = status(peer.channelId);
assert.equal(host.round?.kind, 'WELCOME');
const unauthorized = await fetch(new URL(`/api/channels/${created.channelId}/availability`, base), {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${'x'.repeat(43)}` },
  body: JSON.stringify({ kind: 'scene', scene: 'BRB' }),
});
assert.equal(unauthorized.status, 401);
process.stdout.write(
  `${JSON.stringify({ synthetic: true, studio: 'hatched', sessionId: session.id, descendantHost: peer.channelId })}\n`,
);
