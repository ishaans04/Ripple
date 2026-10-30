import type pg from 'pg';

export interface Metric {
  name: string;
  numerator: number;
  denominator: number;
  /** Null when the denominator is zero; a missing ratio is never shown as zero. */
  ratio: number | null;
  definition: string;
  limit: string;
}
export interface MetricsReport {
  worldId: string;
  channelId: string | null;
  population: 'live' | 'sandbox';
  counts: Record<string, number>;
  metrics: Metric[];
  medianSecondsToFirstCreature: number | null;
  lineageBreadth: { lineageId: string; hosts: number }[];
  disclaimer: string;
}

const metric = (
  name: string,
  numerator: number,
  denominator: number,
  definition: string,
  limit: string,
): Metric => ({
  name,
  numerator,
  denominator,
  ratio: denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000,
  definition,
  limit,
});

/**
 * PRD section 20 and addendum section 28 metrics from recorded events. Live and sandbox
 * populations are reported separately; replay worlds record no events.
 */
export async function computeMetrics(
  pool: pg.Pool,
  worldId: string,
  channelId: string | null,
  population: 'live' | 'sandbox',
): Promise<MetricsReport> {
  const scope = [worldId, channelId, population === 'sandbox'];
  const rows = (
    await pool.query<{ type: string; count: number }>(
      `select type,count(*)::int as count from analytics_events where world_id=$1 and ($2::uuid is null or channel_id=$2)
      and coalesce((aggregates->>'sandbox')::boolean,false)=$3 group by type`,
      scope,
    )
  ).rows;
  const counts: Record<string, number> = Object.fromEntries(
    rows.map((row) => [row.type, row.count]),
  );
  const count = (type: string) => counts[type] ?? 0;
  const split = async (type: string, key: string) =>
    Object.fromEntries(
      (
        await pool.query<{ value: string | null; count: number }>(
          `select aggregates->>$4 as value,count(*)::int as count from analytics_events where world_id=$1 and ($2::uuid is null or channel_id=$2)
          and coalesce((aggregates->>'sandbox')::boolean,false)=$3 and type=$5 group by 1`,
          [...scope, key, type],
        )
      ).rows.map((row) => [row.value ?? 'unknown', row.count]),
    ) as Record<string, number>;
  const received = await split('raid_received', 'outcome');
  const declinedOrCapped = Object.entries(received)
    .filter(([outcome]) => /DECLINE|REFUSE|FULL|BLOCK|CAP|NOT_ENROLLED/i.test(outcome))
    .reduce((sum, [, value]) => sum + value, 0);
  const welcomes = (
    await pool.query<{ active: number; total: number }>(
      `select count(*) filter (where (aggregates->>'votes')::int>0)::int as active,count(*)::int as total from analytics_events
      where world_id=$1 and ($2::uuid is null or channel_id=$2) and coalesce((aggregates->>'sandbox')::boolean,false)=$3 and type='welcome_completed'`,
      scope,
    )
  ).rows[0] ?? { active: 0, total: 0 };
  const participation = (
    await pool.query<{ voters: number; observed: number }>(
      `select coalesce(sum(r.vote_count),0)::int as voters,coalesce(sum(r.distinct_accounts),0)::int as observed from rounds r join channels c on c.world_id=r.world_id and c.id=r.channel_id
      where r.world_id=$1 and ($2::uuid is null or r.channel_id=$2) and r.kind='MUTATION' and r.resolution is not null`,
      [worldId, channelId],
    )
  ).rows[0] ?? { voters: 0, observed: 0 };
  const hosts = (
    await pool.query<{ hosts: number; returning: number }>(
      `select count(distinct c.id)::int as hosts,count(distinct a.channel_id)::int as returning from channels c
      left join analytics_events a on a.world_id=c.world_id and a.channel_id=c.id and a.type='host_returned'
      where c.world_id=$1 and ($2::uuid is null or c.id=$2)`,
      [worldId, channelId],
    )
  ).rows[0] ?? { hosts: 0, returning: 0 };
  const firstCreature =
    (
      await pool.query<{ seconds: number | null }>(
        `select percentile_cont(0.5) within group (order by extract(epoch from seeded.at-started.at))::float as seconds
      from (select channel_id,min(created_at) as at from analytics_events where world_id=$1 and type='onboarding_started' group by 1) started
      join (select channel_id,min(created_at) as at from analytics_events where world_id=$1 and type='strain_seeded' group by 1) seeded using (channel_id)
      where ($2::uuid is null or channel_id=$2) and seeded.at>=started.at`,
        [worldId, channelId],
      )
    ).rows[0]?.seconds ?? null;
  const breadth = (
    await pool.query<{ lineage_id: string; hosts: number }>(
      `select o.lineage_id,count(distinct r.channel_id)::int as hosts from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id
      where r.world_id=$1 and r.role in ('resident','visitor') and ($2::uuid is null or exists(select 1 from organisms x join residencies y on y.world_id=x.world_id and y.organism_id=x.id where x.world_id=o.world_id and x.lineage_id=o.lineage_id and y.channel_id=$2))
      group by 1 order by 2 desc,1 limit 20`,
      [worldId, channelId],
    )
  ).rows;
  const approved = count('proposal_approved'),
    rejected = count('proposal_rejected');
  return {
    worldId,
    channelId,
    population,
    counts,
    metrics: [
      metric(
        'Setup completion',
        count('onboarding_completed'),
        count('onboarding_started'),
        'Hosts reaching a verified overlay / hosts starting OAuth',
        'Measures onboarding, not gameplay quality',
      ),
      metric(
        'Chat participation',
        participation.voters,
        participation.observed,
        'Accepted mutation votes / distinct accounts observed in the same resolved rounds',
        'Not total viewers or watch-time conversion; observation accounts approximate the ballot-period chatters',
      ),
      metric(
        'Arrival reliability',
        count('child_admitted'),
        count('raid_received') - declinedOrCapped,
        'Admitted raids / eligible raid receipts (deliberate declines and caps excluded and counted separately)',
        `Declines, caps and unenrolled destinations: ${declinedOrCapped}`,
      ),
      metric(
        'Welcome completion',
        welcomes.active,
        count('child_admitted'),
        'Admitted visits completing a welcome with at least one vote / admitted visits',
        `No-vote default welcomes reported separately: ${welcomes.total - welcomes.active}`,
      ),
      metric(
        'Dormant contribution',
        count('dormant_activated'),
        count('dormant_captured'),
        'Activated dormant options / captures',
        'A participation hypothesis, not proof of retention',
      ),
      metric(
        'Trace engagement',
        count('trace_kept'),
        count('trace_kept') + count('trace_cleared'),
        'Kept / decided trace offers',
        'Costs and host acceptance must be read alongside it',
      ),
      metric(
        'Repeat use',
        hosts.returning,
        hosts.hosts,
        'Hosts returning for another active session / hosts',
        'Does not identify silent individual viewers',
      ),
      metric(
        'Studio participation',
        count('proposal_submitted'),
        count('studio_opened'),
        'Accepted proposals (including replacements) / studios opened',
        'Counts submissions, not unique artists or attention',
      ),
      metric(
        'Editor-to-submission completion',
        count('proposal_submitted'),
        count('editor_opened'),
        'Accepted proposals / editor openings',
        'Editor openings include local practice and repeat visits',
      ),
      metric(
        'Camera versus fallback',
        count('camera_enabled'),
        count('camera_enabled') + count('fallback_selected'),
        'Editor sessions using the camera / sessions using the camera or confirming with pointer only',
        `Camera failures: ${count('camera_failed')}. Input claims cannot be verified and confer nothing`,
      ),
      metric(
        'Selection participation',
        count('studio_vote_accepted'),
        count('shortlist_published'),
        'Accepted studio votes / studio ballots',
        'One vote per account per ballot',
      ),
      metric(
        'Approval rate',
        approved,
        approved + rejected,
        'Approved winners / reviewed winners',
        'Automatic approvals count as approved',
      ),
      metric(
        'Hatch success',
        count('adaptation_hatched'),
        approved,
        'Hatched designs / approved designs',
        'Released, expired and revalidation failures do not hatch',
      ),
      metric(
        'Reuse through descendants',
        count('inherited_blueprint_seen'),
        count('adaptation_hatched'),
        'Arrivals carrying a committed design / hatched designs',
        'Raid traffic, not design popularity',
      ),
    ],
    medianSecondsToFirstCreature: firstCreature,
    lineageBreadth: breadth.map((row) => ({ lineageId: row.lineage_id, hosts: row.hosts })),
    disclaimer:
      'Product signals only. They do not prove viewer retention or watch time, and no video, landmarks or viewer identities are collected to compute them.',
  };
}
