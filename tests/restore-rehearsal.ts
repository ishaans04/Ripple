import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase } from '@ripple/database/testing';
import { releaseStudioFixture } from '../apps/server/src/release/studio-fixture.ts';
import { canonicalGameProjection } from '../apps/server/src/game/replay.ts';
import {
  exportAcceptedWorld,
  replayAcceptedWorld,
  compareWorldReplay,
} from '../apps/server/src/game/world-replay.ts';
import { forgetArtist, resolvePublicCredits } from '../apps/server/src/privacy/credits.ts';
import { exportErasureLedger, applyErasureLedger } from '../apps/server/src/privacy/ledger.ts';
import { maintainData } from '../apps/server/src/privacy/maintenance.ts';

const source = await createTemporaryDatabase(),
  target = await createTemporaryDatabase();
const sourcePool = new pg.Pool({ connectionString: source.connectionString }),
  targetPool = new pg.Pool({ connectionString: target.connectionString });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const docker = (args: string[], input?: Buffer) =>
  execFileSync('docker', ['compose', 'exec', '-T', 'db', ...args], {
    ...(input ? { input } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });
try {
  // Refuse to dump/restore a different database server accidentally. Targets are generated fixtures only.
  const system = (
    await sourcePool.query<{ system_identifier: string }>(
      'select system_identifier::text from pg_control_system()',
    )
  ).rows[0]?.system_identifier;
  assert.ok(system, 'PostgreSQL system identifier must be available');
  assert.equal(
    docker([
      'psql',
      '-U',
      'ripple',
      '-d',
      'postgres',
      '-Atc',
      'select system_identifier from pg_control_system()',
    ])
      .toString()
      .trim(),
    system,
    'TEST_DATABASE_URL must address the Compose PostgreSQL instance',
  );
  const sourceName = new URL(source.connectionString).pathname.slice(1),
    targetName = new URL(target.connectionString).pathname.slice(1);
  for (const name of [sourceName, targetName]) assert.match(name, /^ripple_test_[a-f0-9]{12}$/);
  await runMigrations(sourcePool);
  const world = await releaseStudioFixture(sourcePool);
  const bundle = await exportAcceptedWorld(sourcePool, world.worldId);
  assert.equal(JSON.stringify(bundle).includes('SyntheticRestoreArtist'), false);
  const before = await Promise.all(
    [world.channelId, world.neighborId].map((channelId) =>
      canonicalGameProjection(sourcePool, { worldId: world.worldId, channelId }),
    ),
  );
  const dumpStarted = performance.now();
  const backup = docker(['pg_dump', '-U', 'ripple', '-d', sourceName, '-Fc', '--no-owner']);
  const dumpMs = performance.now() - dumpStarted;
  // This request occurs after the snapshot. Its independent ledger must defeat restored identity.
  await forgetArtist(sourcePool, world.worldId, world.artistKey);
  const ledger = await exportErasureLedger(sourcePool);
  const restoreStarted = performance.now();
  docker(
    [
      'pg_restore',
      '-U',
      'ripple',
      '-d',
      targetName,
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
    ],
    backup,
  );
  const restoreMs = performance.now() - restoreStarted;
  await runMigrations(targetPool);
  assert.equal(await resolvePublicCredits(targetPool, world.creditToken), 'SyntheticRestoreArtist');
  await applyErasureLedger(targetPool, ledger);
  await maintainData(targetPool);
  assert.equal(await resolvePublicCredits(targetPool, world.creditToken), 'Former artist');
  const restored = await exportAcceptedWorld(targetPool, world.worldId);
  assert.deepEqual(restored, bundle);
  const after = await Promise.all(
    [world.channelId, world.neighborId].map((channelId) =>
      canonicalGameProjection(targetPool, { worldId: world.worldId, channelId }),
    ),
  );
  assert.deepEqual(after, before);
  const replayStarted = performance.now(),
    replay = await replayAcceptedWorld(targetPool, restored);
  const comparison = await compareWorldReplay(
    targetPool,
    world.worldId,
    replay.worldId,
    replay.channelIds,
  );
  assert.ok(comparison.length === 2 && comparison.every((row) => row.equal));
  const output = resolve(process.env.RESTORE_EVIDENCE_PATH ?? 'tmp/phase10-restore.json');
  await mkdir(resolve('tmp'), { recursive: true });
  await writeFile(resolve('tmp/phase10-fixture.dump'), backup, { mode: 0o600 });
  const report = {
    synthetic: true,
    method:
      'PostgreSQL custom pg_dump -> separate empty PostgreSQL database -> erasure ledger -> accepted-record replay',
    postgres: (await targetPool.query<{ version: string }>('select version()')).rows[0]?.version,
    dumpBytes: backup.length,
    dumpSha256: hash(backup),
    dumpMs,
    restoreMs,
    replayMs: performance.now() - replayStarted,
    channels: comparison,
    projectionSha256: before.map(hash),
    acceptedBundleSha256: hash(JSON.stringify(bundle)),
    postBackupErasureReapplied: true,
    lostAcknowledgedInputs: 0,
    rpo: 'Quiescent fixture snapshot; no live RPO claim',
    liveAcceptance: false,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await sourcePool.end();
  await targetPool.end();
  await source.drop();
  await target.drop();
}
