import type pg from 'pg';
/** Private operator diagnostics. No names, credentials, capabilities, raw chat or artist keys. */
export async function operationalStatus(pool: pg.Pool) {
  const [channels, deadlines, delivery, storage] = await Promise.all([
    pool.query(`select w.mode,count(*)::int channels,coalesce(sum(c.intake_sequence-c.processed_sequence),0)::int backlog,
      count(*) filter(where not c.healthy)::int unhealthy,count(*) filter(where c.paused)::int paused,
      coalesce(max(extract(epoch from clock_timestamp()-i.accepted_at)*1000),0)::float oldest_pending_ms
      from channels c join worlds w on w.id=c.world_id left join inbox i on i.world_id=c.world_id and i.channel_id=c.id and i.sequence=c.processed_sequence+1 group by w.mode order by w.mode`),
    pool.query(`select count(*) filter(where d.status in ('pending','leased') and d.due_at<=coalesce(w.clock_at,clock_timestamp()))::int due,
      coalesce(max(extract(epoch from coalesce(w.clock_at,clock_timestamp())-d.due_at)*1000) filter(where d.status in ('pending','leased') and d.due_at<=coalesce(w.clock_at,clock_timestamp())),0)::float max_lag_ms from deadlines d join worlds w on w.id=d.world_id`),
    pool.query(`select
      (select count(*)::int from inbox where error_code is not null) failed_inputs,
      (select count(*)::int from channel_studio where availability_source='bridge' and (bridge_stale or bridge_seen_at<clock_timestamp()-interval '90 seconds')) stale_bridges,
      (select count(*)::int from oauth_grants where revoked_at is not null) revoked_grants,
      (select count(*)::int from twitch_subscriptions where status<>'enabled') subscriptions_needing_attention,
      (select count(*)::int from bot_messages where status in ('pending','sending') and expires_at>clock_timestamp()) bot_backlog`),
    pool.query(
      `select pg_database_size(current_database())::float bytes,blks_read,blks_hit,tup_inserted,tup_updated,stats_reset from pg_stat_database where datname=current_database()`,
    ),
  ]);
  return {
    at: new Date().toISOString(),
    channels: channels.rows as unknown[],
    deadlines: deadlines.rows[0] as unknown,
    delivery: delivery.rows[0] as unknown,
    database: storage.rows[0] as unknown,
    pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
    operatorProcess: { uptimeSeconds: process.uptime(), memory: process.memoryUsage() },
  };
}
