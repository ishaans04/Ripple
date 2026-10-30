import { z } from 'zod';
import type pg from 'pg';
import { forgetArtist } from './credits.ts';

export const erasureLedgerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  erasures: z
    .array(
      z.strictObject({
        worldId: z.uuid(),
        artistKey: z.string().regex(/^[a-f0-9]{64}$/),
        requestedAt: z.iso.datetime(),
      }),
    )
    .max(100000),
});
export async function exportErasureLedger(pool: pg.Pool) {
  const rows = await pool.query<{ world_id: string; artist_key: string; requested_at: Date }>(
    'select world_id,artist_key,requested_at from privacy_erasures order by requested_at,world_id,artist_key limit 100001',
  );
  return erasureLedgerSchema.parse({
    schemaVersion: 1,
    erasures: rows.rows.map((row) => ({
      worldId: row.world_id,
      artistKey: row.artist_key,
      requestedAt: row.requested_at.toISOString(),
    })),
  });
}
/** Reapply the separately retained ledger before a restored database is allowed public traffic. */
export async function applyErasureLedger(pool: pg.Pool, input: unknown) {
  const ledger = erasureLedgerSchema.parse(input);
  let applied = 0,
    absentWorlds = 0;
  for (const entry of ledger.erasures) {
    if ((await pool.query('select id from worlds where id=$1', [entry.worldId])).rowCount !== 1) {
      absentWorlds++;
      continue;
    }
    await forgetArtist(pool, entry.worldId, entry.artistKey);
    applied++;
  }
  return { applied, absentWorlds };
}
