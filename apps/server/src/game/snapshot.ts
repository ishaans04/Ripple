import { randomUUID } from 'node:crypto';
import type { PropagationView, PublicUpdate } from '@ripple/contracts';
import type {
  CommittedAppearance,
  Genome,
  OutcomeExplanation,
  RoundCheckpoint,
  RoundResolution,
  SpecialOption,
} from '@ripple/engine';
import type pg from 'pg';
import { propagationProjectionSql } from './propagation-projection.ts';

export interface ChannelSnapshot {
  channelId: string;
  label: string;
  mode: 'live' | 'sandbox' | 'replay';
  online: boolean;
  healthy: boolean;
  paused: boolean;
  rulesHash: string;
  propagation: PropagationView;
  organism: {
    id: string;
    version: number;
    name: string;
    genome: Genome;
    health: number;
    status: string;
    appearance: CommittedAppearance;
  } | null;
  round: {
    id: string;
    number: number;
    kind: string;
    phase: string;
    clock: RoundCheckpoint['clock'];
    candidates: RoundCheckpoint['candidates'] | readonly SpecialOption[];
    counts: readonly number[];
    baseline: RoundCheckpoint['baseline'];
    voteCloseAtMs: number | null;
    resolution: RoundResolution | null;
    explanation: OutcomeExplanation | null;
    visitorResult: unknown;
    choicePreview?: RoundCheckpoint['choicePreview'];
  } | null;
}
/** A single SQL statement sees one committed MVCC snapshot, even without a transaction. */
export async function readSnapshot(
  queryable: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
  worldId: string,
  channelId: string,
): Promise<{ version: number; payload: ChannelSnapshot; serverTime: string } | null> {
  const result = await queryable.query<{
    state_version: number;
    label: string;
    mode: ChannelSnapshot['mode'];
    online: boolean;
    healthy: boolean;
    paused: boolean;
    rules_hash: string;
    grace_ms: number;
    propagation: PropagationView;
    organism: {
      id: string;
      version: number;
      name: string;
      pulse: number;
      calm: number;
      grit: number;
      drift: number;
      health: number;
      status: string;
      appearance: CommittedAppearance;
    } | null;
    round: {
      id: string;
      number: number;
      kind: string;
      phase: string;
      checkpoint: RoundCheckpoint;
      resolution: RoundResolution | null;
      explanation: OutcomeExplanation | null;
      visitor_result: unknown;
    } | null;
    server_time: Date;
  }>(
    `select c.state_version,c.label,w.mode,c.online,c.healthy,c.paused,c.rules_hash,(c.configuration->>'graceMs')::int as grace_ms,
    (select jsonb_build_object('id',o.id,'version',o.version,'name',o.name,'pulse',o.pulse,'calm',o.calm,'grit',o.grit,'drift',o.drift,'health',o.health,'status',o.status,'appearance',o.appearance)
      from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id
      where r.world_id=c.world_id and r.channel_id=c.id and r.role='resident' order by (r.ended_at is null) desc,r.started_at desc limit 1) as organism,
    (select jsonb_build_object('id',r.id,'number',r.number,'kind',r.kind,'phase',r.phase,'checkpoint',r.checkpoint,'resolution',r.resolution,'explanation',r.explanation,'visitor_result',r.visitor_result)
      from rounds r where r.world_id=c.world_id and r.channel_id=c.id order by r.number desc limit 1) as round,
    ${propagationProjectionSql} as propagation,
    date_trunc('milliseconds',clock_timestamp()) as server_time
    from channels c join worlds w on w.id=c.world_id where c.world_id=$1 and c.id=$2 and (w.expires_at is null or w.expires_at>clock_timestamp())`,
    [worldId, channelId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const organism = row.organism;
  const round = row.round;
  return {
    version: row.state_version,
    serverTime: row.server_time.toISOString(),
    payload: {
      channelId,
      label: row.label,
      mode: row.mode,
      online: row.online,
      healthy: row.healthy,
      paused: row.paused,
      rulesHash: row.rules_hash,
      propagation: row.propagation,
      organism:
        organism === null
          ? null
          : {
              id: organism.id,
              name: organism.name,
              version: organism.version,
              genome: {
                pulse: organism.pulse,
                calm: organism.calm,
                grit: organism.grit,
                drift: organism.drift,
              },
              health: organism.health,
              status: organism.status,
              appearance: organism.appearance,
            },
      round:
        round === null
          ? null
          : {
              id: round.id,
              number: round.number,
              kind: round.kind,
              phase: round.phase,
              clock: round.checkpoint.clock,
              candidates: round.checkpoint.specialBallot?.options ?? round.checkpoint.candidates,
              counts: round.checkpoint.counts,
              baseline: round.checkpoint.baseline,
              voteCloseAtMs:
                round.phase === 'VOTING' && round.checkpoint.clock.deadlineAtMs !== null
                  ? round.checkpoint.clock.deadlineAtMs - row.grace_ms
                  : null,
              resolution: round.resolution,
              explanation: round.explanation,
              visitorResult: round.visitor_result,
              ...(round.checkpoint.choicePreview === undefined
                ? {}
                : { choicePreview: round.checkpoint.choicePreview }),
            },
    },
  };
}
export async function snapshotEnvelope(
  pool: pg.Pool,
  worldId: string,
  channelId: string,
): Promise<PublicUpdate | null> {
  const snapshot = await readSnapshot(pool, worldId, channelId);
  return snapshot === null
    ? null
    : {
        protocolVersion: 1,
        eventId: randomUUID(),
        worldId,
        topic: `channel:${channelId}`,
        stateVersion: snapshot.version,
        type: 'snapshot',
        serverTime: snapshot.serverTime,
        payload: snapshot.payload,
      };
}
