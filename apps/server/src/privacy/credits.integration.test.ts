import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import {
  createSyntheticWorld,
  syntheticSeedCommand,
  acceptSyntheticCommand,
} from '../game/sandbox.ts';
import { settleSyntheticWorld } from '../game/synthetic-clock.ts';
import { canonicalGameProjection } from '../game/replay.ts';
import { registerArtistIdentity, resolvePublicCredits, forgetArtist } from './credits.ts';
import { exportErasureLedger, applyErasureLedger } from './ledger.ts';
let temporary: TemporaryDatabase, pool: pg.Pool;
beforeAll(async () => {
  temporary = await createTemporaryDatabase();
  pool = new pg.Pool({ connectionString: temporary.connectionString });
  await runMigrations(pool);
});
afterAll(async () => {
  await pool.end();
  await temporary.drop();
});
it('erases artist identity without rewriting accepted history and re-sign-in creates an unrelated pseudonym', async () => {
  const world = await createSyntheticWorld(pool);
  await acceptSyntheticCommand(
    pool,
    world,
    world.ownerCapability,
    crypto.randomUUID(),
    syntheticSeedCommand(),
  );
  await settleSyntheticWorld(pool, world);
  const before = await canonicalGameProjection(pool, world);
  const identity = await registerArtistIdentity(
    pool,
    world.worldId,
    'subject-hash',
    'PrivateArtist',
  );
  expect(
    await registerArtistIdentity(pool, world.worldId, 'subject-hash', 'PrivateArtist'),
  ).toEqual(identity);
  const projection = {
    credit: identity.credit_token,
    text: `Designed by ${identity.credit_token}`,
    genome: { pulse: 6 },
  };
  expect(await resolvePublicCredits(pool, projection)).toMatchObject({
    credit: 'PrivateArtist',
    text: 'Designed by PrivateArtist',
  });
  expect(await forgetArtist(pool, world.worldId, identity.artist_key)).toEqual({
    identitiesDeleted: 1,
    sessionsDeleted: 0,
  });
  expect(await resolvePublicCredits(pool, projection)).toMatchObject({
    credit: 'Former artist',
    genome: { pulse: 6 },
  });
  expect(await canonicalGameProjection(pool, world)).toEqual(before);
  const fresh = await registerArtistIdentity(pool, world.worldId, 'subject-hash', 'PrivateArtist');
  expect(fresh.artist_key).not.toBe(identity.artist_key);
  expect(fresh.credit_token).not.toBe(identity.credit_token);
  expect(await resolvePublicCredits(pool, projection)).toMatchObject({ credit: 'Former artist' });
});
it('keeps identity lookup world-scoped and expires credit independently of game state', async () => {
  const first = await createSyntheticWorld(pool),
    second = await createSyntheticWorld(pool);
  const a = await registerArtistIdentity(pool, first.worldId, 'same-account-hash', 'Name');
  const b = await registerArtistIdentity(pool, second.worldId, 'same-account-hash', 'Name');
  expect(a.artist_key).not.toBe(b.artist_key);
  await forgetArtist(pool, first.worldId, a.artist_key);
  expect(await resolvePublicCredits(pool, b.credit_token)).toBe('Name');
  await pool.query(
    "update artist_identities set expires_at=now()-interval '1 second' where world_id=$1",
    [second.worldId],
  );
  expect(await resolvePublicCredits(pool, b.credit_token)).toBe('Former artist');
});
it('reapplies a post-backup erasure before a restored identity can be published', async () => {
  const world = await createSyntheticWorld(pool);
  const identity = await registerArtistIdentity(
    pool,
    world.worldId,
    'restore-subject',
    'RestoredName',
  );
  const backup = (
    await pool.query<{
      world_id: string;
      subject_hash: string;
      artist_key: string;
      credit_token: string;
      login: string;
      expires_at: Date;
    }>('select * from artist_identities where world_id=$1', [world.worldId])
  ).rows[0]!;
  await forgetArtist(pool, world.worldId, identity.artist_key);
  const ledger = await exportErasureLedger(pool);
  // Reproduce the private mapping an older database backup would restore.
  await pool.query(
    'insert into artist_identities(world_id,subject_hash,artist_key,credit_token,login,expires_at) values($1,$2,$3,$4,$5,$6)',
    [
      backup.world_id,
      backup.subject_hash,
      backup.artist_key,
      backup.credit_token,
      backup.login,
      backup.expires_at,
    ],
  );
  expect(await resolvePublicCredits(pool, identity.credit_token)).toBe('RestoredName');
  await applyErasureLedger(pool, ledger);
  await applyErasureLedger(pool, ledger);
  expect(await resolvePublicCredits(pool, identity.credit_token)).toBe('Former artist');
  await expect(applyErasureLedger(pool, { ...ledger, credentials: 'forbidden' })).rejects.toThrow();
});
