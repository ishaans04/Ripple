import { transaction } from '@ripple/database';
import type pg from 'pg';

/** Only raw processed intake and closed-round membership expire; replay records and receipts stay. */
export async function maintainData(pool: pg.Pool) {
  return transaction(pool, async (client) => {
    const lock = (
      await client.query<{ locked: boolean }>(
        "select pg_try_advisory_xact_lock(hashtext('ripple-maintenance')) as locked",
      )
    ).rows[0];
    if (!lock?.locked) return { skipped: true, deleted: {} };
    const statements: Record<string, string> = {
      artistSessions:
        'delete from artist_sessions where expires_at<=clock_timestamp() or exists(select 1 from artist_identities i where i.world_id=artist_sessions.world_id and i.artist_key=artist_sessions.artist_key and i.expires_at<=clock_timestamp())',
      artistIdentities: 'delete from artist_identities where expires_at<=clock_timestamp()',
      controllerSessions: 'delete from controller_sessions where expires_at<=clock_timestamp()',
      oauthStates: 'delete from oauth_states where expires_at<=clock_timestamp()',
      gatewayTickets: 'delete from gateway_tickets where expires_at<=clock_timestamp()',
      rawInputs: `delete from inbox where ctid in(select i.ctid from inbox i join channels c on i.world_id=c.world_id and i.channel_id=c.id where i.sequence<=c.processed_sequence and i.processed_at<clock_timestamp()-interval '24 hours' limit 10000)`,
      votes: `delete from votes where ctid in(select v.ctid from votes v join rounds r on v.world_id=r.world_id and v.round_id=r.id where r.completed_at<clock_timestamp()-interval '24 hours' limit 10000)`,
      activity: `delete from activity_contributions where ctid in(select a.ctid from activity_contributions a join rounds r on a.world_id=r.world_id and a.round_id=r.id where r.completed_at<clock_timestamp()-interval '24 hours' limit 10000)`,
      providerReceipts:
        "delete from twitch_receipts where received_at<clock_timestamp()-interval '7 days'",
      botMessages:
        "delete from bot_messages where status<>'sending' and expires_at<clock_timestamp()-interval '7 days'",
      botAttempts:
        "delete from bot_send_attempts where attempted_at<clock_timestamp()-interval '7 days'",
      publicUpdates:
        "delete from public_updates where ctid in(select ctid from public_updates where created_at<clock_timestamp()-interval '7 days' limit 10000)",
      revokedGrants:
        "delete from oauth_grants where revoked_at<clock_timestamp()-interval '7 days'",
    };
    const deleted: Record<string, number> = {};
    for (const [name, sql] of Object.entries(statements))
      deleted[name] = (await client.query(sql)).rowCount ?? 0;
    return { skipped: false, deleted };
  });
}

/** Whole-world purge is explicit and atomic. Immutable history permits deletion only after expiry. */
export async function purgeExpiredWorld(pool: pg.Pool, worldId: string) {
  return transaction(pool, async (client) => {
    const world = (
      await client.query<{ expired: boolean }>(
        'select expires_at<=clock_timestamp() as expired from worlds where id=$1 for update',
        [worldId],
      )
    ).rows[0];
    if (!world?.expired) throw new Error('Only an existing expired world may be purged.');
    await client.query("select set_config('ripple.purge_world',$1,true)", [worldId]);
    const tables = (
      await client.query<{ table_name: string }>(
        "select table_name from information_schema.columns where table_schema='public' and column_name='world_id' order by table_name",
      )
    ).rows.map((row) => row.table_name);
    const deleted: Record<string, number> = {};
    let remaining = tables;
    while (remaining.length) {
      const blocked: string[] = [];
      for (const table of remaining) {
        if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected maintenance table name');
        await client.query('savepoint purge_table');
        try {
          deleted[table] =
            (await client.query(`delete from "${table}" where world_id=$1`, [worldId])).rowCount ??
            0;
          await client.query('release savepoint purge_table');
        } catch (error) {
          await client.query('rollback to savepoint purge_table');
          if ((error as { code?: string }).code !== '23503') throw error;
          blocked.push(table);
        }
      }
      if (blocked.length === remaining.length)
        throw new Error(`Cannot purge world dependencies: ${blocked.join(', ')}`);
      remaining = blocked;
    }
    await client.query('delete from worlds where id=$1', [worldId]);
    return { worldId, deleted };
  });
}

export async function purgeExpiredSyntheticWorlds(pool: pg.Pool, limit = 5) {
  const worlds = (
    await pool.query<{ id: string }>(
      "select id from worlds where mode in ('sandbox','replay') and expires_at<=clock_timestamp() order by expires_at limit $1",
      [limit],
    )
  ).rows;
  const purged: string[] = [];
  for (const world of worlds) {
    await purgeExpiredWorld(pool, world.id);
    purged.push(world.id);
  }
  return purged;
}
