import { randomUUID } from 'node:crypto';
import {
  celebrationSchema,
  displayPreferencesSchema,
  familyDigestSchema,
  mechanicsStateSchema,
  type AppearanceMarks,
  type Celebration,
  type DisplayPreferences,
  type FamilyDigest,
  type AppearanceMappingVersion,
  type MechanicsState,
  type PropagationView,
  type PublicUpdate,
  type RoundAnalysis,
} from '@ripple/contracts';
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
import { parseSavedRoundAnalysis, roundAnalysisProjectionSql } from './round-analysis.ts';
import { mechanicsStateProjectionSql } from './mechanics-projection.ts';
import {
  organismAppearanceProvenance,
  organismHostsSql,
  organismOriginSql,
} from './appearance-projection.ts';
import { projectStudio, studioProjectionSql } from './studio-projection.ts';
import type { StudioView } from '@ripple/contracts';

export interface ChannelSnapshot {
  channelId: string;
  label: string;
  mode: 'live' | 'sandbox' | 'replay';
  online: boolean;
  healthy: boolean;
  paused: boolean;
  rulesHash: string;
  propagation: PropagationView;
  familyDigest: FamilyDigest | null;
  display: DisplayPreferences;
  celebration: Celebration | null;
  studio: StudioView;
  mechanics: {
    version: 0 | 1;
    enableRequested: boolean;
    tracesEnabled: boolean;
    state: MechanicsState;
  };
  organism: {
    id: string;
    version: number;
    name: string;
    genome: Genome;
    health: number;
    status: string;
    appearance: CommittedAppearance;
    appearanceMapping: AppearanceMappingVersion;
    marks: AppearanceMarks;
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
    dormantOffer?: RoundCheckpoint['dormantOffer'];
    traceCleared?: RoundCheckpoint['traceCleared'];
    analysis: RoundAnalysis | null;
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
    family_digest: unknown;
    display: unknown;
    celebration: unknown;
    mechanics: ChannelSnapshot['mechanics'];
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
      appearanceMapping: unknown;
      origin: unknown;
      hosts: unknown;
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
      analysis: unknown;
    } | null;
    studio: unknown;
    server_time: Date;
  }>(
    `select c.state_version,c.label,w.mode,c.online,c.healthy,c.paused,c.rules_hash,(c.configuration->>'graceMs')::int as grace_ms,
    (select jsonb_build_object('id',o.id,'version',o.version,'name',o.name,'pulse',o.pulse,'calm',o.calm,'grit',o.grit,'drift',o.drift,'health',o.health,'status',o.status,'appearance',o.appearance,
      'appearanceMapping',o.appearance_mapping,'origin',${organismOriginSql},'hosts',${organismHostsSql})
      from residencies r join organisms o on o.world_id=r.world_id and o.id=r.organism_id
      where r.world_id=c.world_id and r.channel_id=c.id and r.role='resident' order by (r.ended_at is null) desc,r.started_at desc limit 1) as organism,
    (select jsonb_build_object('id',r.id,'number',r.number,'kind',r.kind,'phase',r.phase,'checkpoint',r.checkpoint,'resolution',r.resolution,'explanation',r.explanation,'visitor_result',r.visitor_result,'analysis',${roundAnalysisProjectionSql})
      from rounds r where r.world_id=c.world_id and r.channel_id=c.id and r.kind<>'STUDIO_SELECTION' order by r.number desc limit 1) as round,
    ${propagationProjectionSql} as propagation,
    cp.display,cp.celebration,${studioProjectionSql} as studio,
    (select jsonb_build_object('items',d.items,'remaining',d.remaining) from family_digests d
      where d.world_id=c.world_id and d.channel_id=c.id and c.online) as family_digest,
    jsonb_build_object('version',cp.mechanics_version,'enableRequested',cp.mechanics_requested,'tracesEnabled',cp.traces_enabled,'state',${mechanicsStateProjectionSql}) as mechanics,
    date_trunc('milliseconds',clock_timestamp()) as server_time
    from channels c join worlds w on w.id=c.world_id join channel_play cp on cp.world_id=c.world_id and cp.channel_id=c.id where c.world_id=$1 and c.id=$2 and (w.expires_at is null or w.expires_at>clock_timestamp())`,
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
      familyDigest: row.family_digest === null ? null : familyDigestSchema.parse(row.family_digest),
      display: displayPreferencesSchema.parse(row.display),
      celebration: row.celebration === null ? null : celebrationSchema.parse(row.celebration),
      mechanics: { ...row.mechanics, state: mechanicsStateSchema.parse(row.mechanics.state) },
      studio: projectStudio(row.studio),
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
              ...organismAppearanceProvenance(organism, { includeHosts: false }),
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
              analysis: round.analysis === null ? null : parseSavedRoundAnalysis(round.analysis),
              ...(round.checkpoint.choicePreview === undefined
                ? {}
                : { choicePreview: round.checkpoint.choicePreview }),
              ...(round.checkpoint.dormantOffer === undefined
                ? {}
                : { dormantOffer: round.checkpoint.dormantOffer }),
              ...(round.checkpoint.traceCleared === undefined
                ? {}
                : { traceCleared: round.checkpoint.traceCleared }),
              ...(round.checkpoint.studioHatch === undefined
                ? {}
                : { studioHatch: round.checkpoint.studioHatch }),
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
