import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
assert.equal(git('status', '--porcelain'), '', 'Commit the validated source before packaging.');
const revision = git('rev-parse', 'HEAD');
const files = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n');
for (const file of files)
  assert.ok(
    !/(^|\/)(node_modules|tmp|\.git)(\/|$)|\.(dump|backup)$/.test(file) &&
      (!/(^|\/)\.env(?:\.|$)/.test(file) || file === '.env.example'),
    `Private/build artifact in source archive: ${file}`,
  );
for (const required of [
  'README.md',
  '.env.example',
  'Dockerfile',
  'compose.yaml',
  'railway.json',
  'docs/plan.md',
  'docs/deployment.md',
  'docs/operations.md',
  'docs/privacy-operations.md',
  'docs/submission.md',
  'docs/evidence/phase10.md',
  'docs/licenses/npm-runtime.json',
  'docs/demo/ripple-synthetic.webm',
])
  assert.ok(files.includes(required), `Missing submission artifact ${required}`);
const loadSchema = z.object({
  workload: z.object({
    channels: z.literal(100),
    sockets: z.literal(300),
    studios: z.number().min(20),
    artistsInLargestStudio: z.number().min(50),
    seconds: z.number().min(60),
    notifications: z.number(),
    acked: z.number(),
  }),
  callbackMs: z.object({ p95: z.number().lt(500) }),
  acceptedToObservedCommitMs: z.object({ p95: z.number().lt(1000) }),
  publicMutationCommitMs: z.object({ p95: z.number().lt(1000) }),
  remainingAcknowledged: z.literal(0),
  convergedSockets: z.literal(300),
  duplicateCommitments: z.literal(0),
  openSockets: z.literal(300),
  serverErrors: z.literal(''),
  errors: z.record(z.string(), z.number()),
  crashRecovery: z.object({
    committedRecords: z.literal(1),
    publicUpdates: z.literal(1),
    stderr: z.literal(''),
    receiptReused: z.literal(true),
    restartedWorkerReapplied: z.literal(false),
    convergedSockets: z.literal(300),
  }),
});
for (const file of ['phase10-load.json', 'phase10-load-trial2.json']) {
  const load = loadSchema.parse(JSON.parse(await readFile(`docs/evidence/${file}`, 'utf8')));
  assert.equal(load.workload.notifications, load.workload.acked);
  assert.equal(Object.keys(load.errors).length, 0);
}
const restore = z
  .object({
    channels: z.array(z.object({ equal: z.literal(true) })).min(2),
    postBackupErasureReapplied: z.literal(true),
  })
  .parse(JSON.parse(await readFile('docs/evidence/phase10-restore.json', 'utf8')));
for (const browser of ['chrome', 'edge'])
  z.object({
    inputToNextFrameP95Ms: z.number().lt(100),
    animationFrameP95Ms: z.number().lt(150),
    maxInFlight: z.literal(1),
    editingWrites: z.literal(0),
  }).parse(JSON.parse(await readFile(`docs/evidence/phase10-client-${browser}.json`, 'utf8')));
const authors = git('log', '1662f8f..HEAD', '--format=%an <%ae>|%cn <%ce>').split('\n');
assert.ok(authors.length >= 15, 'Phase 10 requires at least fifteen substantive focused commits.');
assert.ok(
  authors.every(
    (line) =>
      line === 'ishaans04 <sharmaishaaan04@gmail.com>|ishaans04 <sharmaishaaan04@gmail.com>',
  ),
);
assert.ok(!/co-authored-by:/i.test(git('log', '1662f8f..HEAD', '--format=%B')));
let ci =
  'Current CI job produces a candidate archive; other jobs and live gates must still be reviewed.';
if (process.env.CI !== 'true') {
  const runs = z
    .array(z.object({ databaseId: z.number(), status: z.string(), conclusion: z.string() }))
    .parse(
      JSON.parse(
        execFileSync(
          'gh',
          [
            'run',
            'list',
            '--commit',
            revision,
            '--workflow',
            'CI',
            '--limit',
            '10',
            '--json',
            'databaseId,status,conclusion',
          ],
          { encoding: 'utf8' },
        ),
      ),
    );
  const green = runs.find((run) => run.status === 'completed' && run.conclusion === 'success');
  assert.ok(green, 'The exact packaged commit must have a green CI run.');
  ci = `https://github.com/ishaans04/Ripple/actions/runs/${green.databaseId}`;
}
const archive = execFileSync('git', ['archive', '--format=zip', '--prefix=Ripple/', 'HEAD'], {
  maxBuffer: 64 * 1024 * 1024,
});
const directory = resolve('tmp/release');
await mkdir(directory, { recursive: true });
const filename = `Ripple-${revision.slice(0, 12)}.zip`;
await writeFile(resolve(directory, filename), archive);
const manifest = {
  sourceCommit: revision,
  filename,
  sha256: createHash('sha256').update(archive).digest('hex'),
  bytes: archive.length,
  trackedFiles: files.length,
  phase10Commits: authors.length,
  ci,
  restoreChannels: restore.channels.length,
  releaseStatus: 'candidate-awaiting-deferred-live-acceptance',
  deferred: [
    'Authorized broadcaster and bot setup',
    'Hosted HTTPS/provider recovery validation',
    'Real OBS capture and bridge rehearsal',
    'Two real channels: physical hand/pointer proposal, chat selection, approval, hatch, raid and inherited design',
    'Authentic live demo segments and final operator sign-off',
  ],
};
await writeFile(resolve(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
