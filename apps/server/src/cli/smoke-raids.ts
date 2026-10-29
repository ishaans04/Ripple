import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { channelViewSchema, publicUpdateSchema } from '@ripple/contracts';

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
  .object({
    worldId: z.uuid(),
    channelId: z.uuid(),
    ownerCapability: z.string(),
    settlement: z.object({ pending: z.literal(false) }),
  })
  .parse(run(['create']));
function command(name: string, channel: string, ...args: string[]) {
  const response = z
    .object({
      snapshot: publicUpdateSchema,
      result: z.unknown().optional(),
      settlement: z.object({ pending: z.literal(false) }).optional(),
    })
    .parse(run([name, created.worldId, channel, ...args], created.ownerCapability));
  if (name === 'advance') z.object({ pending: z.literal(false) }).parse(response.result);
  return response;
}
function status(channel = created.channelId) {
  return channelViewSchema.parse(command('status', channel).snapshot.payload);
}
function advance(ms: number) {
  command('advance', created.channelId, String(ms));
}
const peer = z
  .object({ channelId: z.uuid(), readCapability: z.string() })
  .parse(command('peer', created.channelId, 'Receiver', randomUUID()).result);
command('seed', peer.channelId);
command('policy', peer.channelId, 'accept');
command('prepare', created.channelId);
advance(16000);
let source = status();
assert.ok(source.round !== null);
assert.equal(source.round.kind, 'PREPARATION');
const shield =
  source.round.candidates.findIndex((c) => c.effect === 'Shield the next descendant') + 1;
assert.ok(shield > 0);
command('vote', created.channelId, 'preparer', String(shield));
advance(3200);
assert.equal(status().propagation?.preparation, 'shield');
const before = status(peer.channelId),
  receipt = randomUUID();
command('raid', created.channelId, peer.channelId, receipt);
const duplicate = command('raid', created.channelId, peer.channelId, receipt);
assert.equal(z.object({ duplicate: z.boolean() }).parse(duplicate.result).duplicate, true);
let receiver = status(peer.channelId);
assert.equal(receiver.round?.id, before.round?.id);
assert.equal(receiver.propagation?.visitor?.health, 28);
assert.equal(receiver.propagation.admissions.length, 1);
advance(12000);
advance(800);
receiver = status(peer.channelId);
assert.ok(receiver.round !== null);
assert.equal(receiver.round.kind, 'WELCOME');
const shelter = receiver.round.candidates.findIndex((c) => c.effect === 'Shelter') + 1;
assert.ok(shelter > 0);
command('vote', peer.channelId, 'welcomer', String(shelter));
advance(3200);
for (const actor of ['alice', 'bob', 'carol']) command('activity', peer.channelId, actor);
advance(12000);
receiver = status(peer.channelId);
assert.equal(receiver.propagation?.lastContest?.outcome, 'sheltered');
assert.equal(receiver.propagation.lastContest.moved, 5);
advance(800);
advance(3200);
for (const actor of ['alice', 'bob', 'carol']) command('activity', peer.channelId, actor);
advance(12000);
receiver = status(peer.channelId);
assert.equal(receiver.propagation?.lastContest?.outcome, 'resident');
assert.equal(receiver.propagation.visitor, null);
assert.equal(receiver.propagation.admissions.length, 0);
source = status();
assert.equal(source.organism?.status, 'ALIVE');
assert.equal(source.propagation?.outgoing[0]?.outcome, 'VISITOR_LOST');
assert.equal(source.propagation.resident?.livingBranches, 1);
const base = new URL(
  process.env.RIPPLE_SMOKE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`,
);
const url = new URL(`/api/worlds/${created.worldId}/snapshot`, base);
url.searchParams.set('channelId', peer.channelId);
const response = await fetch(url, { headers: { authorization: `Bearer ${peer.readCapability}` } });
assert.equal(response.status, 200);
assert.deepEqual(
  channelViewSchema.parse(publicUpdateSchema.parse(await response.json()).payload),
  receiver,
);
const laterId = randomUUID();
command('raid-unknown', created.channelId, laterId, randomUUID());
const invitation = status().propagation?.outgoing[0];
assert.ok(invitation !== undefined && invitation.childId !== null);
assert.equal(invitation.outcome, 'NOT_ENROLLED');
assert.equal(invitation.destinationChannelId, null);
assert.equal(status().propagation?.resident?.livingBranches, 2);
command('peer', created.channelId, 'Later receiver', laterId);
advance(1000);
command('claim', laterId, invitation.id, String(invitation.version));
const historical = status(laterId);
assert.equal(historical.round?.kind, 'WELCOME');
assert.equal(historical.organism, null);
const historicalView = historical.propagation;
assert.ok(historicalView !== undefined && historicalView.visitor !== null);
assert.equal(historicalView.visitor.health, 28);
assert.equal(historicalView.admissions[0]?.historical, true);
assert.equal(historicalView.admissions[0].expiresAt, invitation.expiresAt);
assert.equal(historicalView.admissions[0].childId, invitation.childId);
process.stdout.write(
  `${JSON.stringify({ synthetic: true, worldId: created.worldId, checks: ['two-channel clock', 'standing Shield', 'duplicate raid', 'unchanged open ballot', 'welcome', 'finite shelter', 'matched contest', 'fossil', 'retained source', 'scoped HTTP', 'historical adoption', 'original invitation expiry', 'captured child'] })}\n`,
);
