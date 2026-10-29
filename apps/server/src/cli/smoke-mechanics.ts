import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { channelViewSchema, publicUpdateSchema, roundAnalysisSchema } from '@ripple/contracts';

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
    readCapability: z.string(),
    settlement: z.object({ pending: z.literal(false) }),
  })
  .parse(run(['create']));
function command(name: string, channelId: string, ...args: string[]) {
  const response = z
    .object({
      snapshot: publicUpdateSchema,
      result: z.unknown().optional(),
      settlement: z.object({ pending: z.literal(false) }).optional(),
    })
    .parse(run([name, created.worldId, channelId, ...args], created.ownerCapability));
  if (name === 'advance') z.object({ pending: z.literal(false) }).parse(response.result);
  return response;
}
function status(channelId = created.channelId) {
  return channelViewSchema.parse(command('status', channelId).snapshot.payload);
}
function advance(ms: number) {
  command('advance', created.channelId, String(ms));
}
function activity(channelId: string) {
  for (const actor of ['alice', 'bob', 'carol']) command('activity', channelId, actor);
}
assert.equal(status().mechanics?.version, 1);
for (let i = 0; i < 5; i++) command('vote', created.channelId, `minority-${i}`, i < 3 ? '1' : '2');
advance(3200);
const captured = status().mechanics?.state?.dormant[0];
assert.ok(captured !== undefined);
assert.equal(captured.supporters, 2);
assert.equal(captured.totalVotes, 5);
assert.equal(captured.remainingRounds, 3);
const peer = z
  .object({ channelId: z.uuid(), readCapability: z.string() })
  .parse(command('peer', created.channelId, 'Mechanics host', randomUUID()).result);
command('policy', peer.channelId, 'accept');
command('raid', created.channelId, peer.channelId, randomUUID());
let host = status(peer.channelId);
assert.equal(host.round?.kind, 'WELCOME');
const inherited = host.mechanics?.state?.dormant[0];
assert.ok(inherited !== undefined);
assert.equal(inherited.inherited, true);
assert.equal(inherited.remainingRounds, captured.remainingRounds);
assert.equal(inherited.originChannelId, created.channelId);
assert.equal(inherited.sourceRoundId, captured.sourceRoundId);
for (let i = 0; i < 2; i++) {
  advance(3200);
  activity(peer.channelId);
  advance(12000);
  host = status(peer.channelId);
  assert.equal(host.round?.analysis?.participants[0]?.actual.outcome, 'applied');
  assert.ok(host.round.analysis.participants[0].ancestor !== null);
  if (i === 0) assert.equal(host.mechanics?.state?.pendingCount, 0);
  else assert.equal(host.round.analysis.alternative?.confidence, 'confident');
  advance(800);
}
host = status(peer.channelId);
assert.equal(host.round?.kind, 'TRACE');
assert.equal(host.mechanics?.state?.pendingCount, 1);
const offered = host.mechanics.state.pendingTraces[0];
assert.ok(offered !== undefined);
assert.equal(offered.originChannelId, created.channelId);
assert.equal(offered.remainingRounds, 3);
command('vote', peer.channelId, 'keep', '1');
advance(3200);
host = status(peer.channelId);
assert.equal(host.mechanics?.state?.activeTrace?.id, offered.id);
assert.equal(host.mechanics.state.activeTrace.remainingRounds, 3);
command('pause', peer.channelId);
advance(300000);
assert.equal(status(peer.channelId).mechanics?.state?.activeTrace?.remainingRounds, 3);
command('resume', peer.channelId);
activity(peer.channelId);
advance(12000);
host = status(peer.channelId);
assert.equal(host.mechanics?.state?.activeTrace?.remainingRounds, 2);
assert.ok(host.round !== null);
const scoredRoundId = host.round.id;
const base = new URL(
    process.env.RIPPLE_SMOKE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`,
  ),
  analysisUrl = new URL(`/api/rounds/${scoredRoundId}/explanation`, base);
analysisUrl.searchParams.set('worldId', created.worldId);
analysisUrl.searchParams.set('channelId', peer.channelId);
async function readAnalysis() {
  const response = await fetch(analysisUrl, {
    headers: { authorization: `Bearer ${peer.readCapability}` },
  });
  assert.equal(response.status, 200);
  return roundAnalysisSchema.parse(await response.json());
}
const saved = await readAnalysis();
assert.deepEqual(saved, host.round.analysis);
assert.equal(saved.traceAttribution?.id, offered.id);
assert.equal(saved.traceAttribution.originChannelId, created.channelId);
assert.equal(saved.participants[0]?.actual.score.trace?.template, offered.template);
assert.equal(
  (await fetch(analysisUrl, { headers: { authorization: `Bearer ${created.readCapability}` } }))
    .status,
  401,
);
for (const remaining of [1, 0]) {
  advance(800);
  advance(3200);
  activity(peer.channelId);
  advance(12000);
  host = status(peer.channelId);
  assert.equal(host.mechanics?.state?.activeTrace?.remainingRounds ?? 0, remaining);
}
assert.equal(host.mechanics?.state?.activeTrace, null);
assert.equal(host.mechanics.state.recentTraces[0]?.status, 'expired');
assert.equal(host.mechanics.state.dormant.length, 0);
command('traces', peer.channelId, 'false');
command('traces', peer.channelId, 'true');
assert.equal(status(peer.channelId).mechanics?.state?.pendingCount, 0);
assert.deepEqual(await readAnalysis(), saved);
process.stdout.write(
  `${JSON.stringify({
    synthetic: true,
    worldId: created.worldId,
    checks: [
      'version-one genesis',
      'minority capture',
      'exact dormant inheritance',
      'matched ancestor and rejected-choice records',
      'earned trace Keep',
      'pause preservation',
      'three-valid-observation expiry',
      'scoped saved analysis',
      'immutable attribution',
      'no toggle revival',
    ],
  })}\n`,
);
