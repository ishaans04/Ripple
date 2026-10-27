import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from '../client.ts';
import { runMigrations } from '../migrate.ts';
import { createTemporaryDatabase, type TemporaryDatabase } from '../testing.ts';
import { worlds } from './worlds.ts';

const rulesHash = 'a'.repeat(64);
const capabilityHash = 'b'.repeat(64);
const inOneDay = () => new Date(Date.now() + 86_400_000);

describe('worlds table', () => {
  let temporary: TemporaryDatabase;
  let database: DatabaseHandle;

  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    database = createDatabase({
      connectionString: temporary.connectionString,
      applicationName: 'ripple-test',
      onIdleClientError: (error) => {
        throw error;
      },
    });
    await runMigrations(database.pool);
  });

  afterAll(async () => {
    await database.close();
    await temporary.drop();
  });

  it('creates a live world without an owner or expiry', async () => {
    const [world] = await database.db
      .insert(worlds)
      .values({ mode: 'live', rulesHash })
      .returning();
    expect(world?.mode).toBe('live');
    expect(world?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('requires sandbox worlds to have an owner capability and an expiry', async () => {
    await expect(
      database.db.insert(worlds).values({ mode: 'sandbox', rulesHash, expiresAt: inOneDay() }),
    ).rejects.toMatchObject({ cause: { constraint: 'worlds_sandbox_owned_and_expiring' } });
    await expect(
      database.db
        .insert(worlds)
        .values({ mode: 'sandbox', rulesHash, ownerCapabilityHash: capabilityHash }),
    ).rejects.toMatchObject({ cause: { constraint: 'worlds_sandbox_owned_and_expiring' } });

    const [sandbox] = await database.db
      .insert(worlds)
      .values({
        mode: 'sandbox',
        rulesHash,
        ownerCapabilityHash: capabilityHash,
        expiresAt: inOneDay(),
      })
      .returning();
    expect(sandbox?.mode).toBe('sandbox');
  });

  it('rejects hashes that are not lowercase SHA-256 hex', async () => {
    await expect(
      database.db.insert(worlds).values({ mode: 'live', rulesHash: 'not-a-hash' }),
    ).rejects.toMatchObject({ cause: { constraint: 'worlds_rules_hash_format' } });
    await expect(
      database.db
        .insert(worlds)
        .values({ mode: 'live', rulesHash, ownerCapabilityHash: 'B'.repeat(64) }),
    ).rejects.toMatchObject({ cause: { constraint: 'worlds_owner_capability_hash_format' } });
  });

  it('never allows a world to change mode', async () => {
    const [world] = await database.db
      .insert(worlds)
      .values({ mode: 'replay', rulesHash })
      .returning({ id: worlds.id });
    const failure: unknown = await database.db
      .update(worlds)
      .set({ mode: 'live' })
      .where(eq(worlds.id, world!.id))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const cause = (failure as Error).cause as { code: string; message: string };
    expect(cause.code).toBe('23514');
    expect(cause.message).toMatch(/mode is immutable/);

    const [unchanged] = await database.db.select().from(worlds).where(eq(worlds.id, world!.id));
    expect(unchanged?.mode).toBe('replay');
  });
});
