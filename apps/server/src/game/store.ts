import { roundTimingsSchema, type RoundTimings } from '@ripple/contracts';
import type {
  CommittedAppearance,
  MutationSlots,
  MechanicsPolicy,
  RoundCheckpoint,
  Ruleset,
} from '@ripple/engine';
import type pg from 'pg';
import { storedRules, storedMechanics } from './immutable-config.ts';

export interface ChannelRow {
  world_id: string;
  id: string;
  label: string;
  seed: string;
  rules_hash: string;
  configuration: unknown;
  online: boolean;
  healthy: boolean;
  paused: boolean;
  studio_hold: boolean;
  intake_sequence: number;
  processed_sequence: number;
  state_version: number;
  checksum: string;
}
export interface OrganismRow {
  id: string;
  version: number;
  pulse: number;
  calm: number;
  grit: number;
  drift: number;
  health: number;
  status: 'ALIVE' | 'HARBOR' | 'FOSSIL' | 'ARCHIVED';
  mutation_slots: MutationSlots;
  appearance: CommittedAppearance;
  design_version: number;
  appearance_hash: string | null;
}
export interface RoundRow {
  id: string;
  number: number;
  organism_id: string;
  phase: string;
  checkpoint: RoundCheckpoint;
  completed_at: Date | null;
}
export interface GameContext {
  client: pg.PoolClient;
  channel: ChannelRow;
  organism: OrganismRow | null;
  round: RoundRow | null;
  rules: Ruleset;
  timings: RoundTimings;
  /** The world identity bound into studio challenges and blueprints; a replay keeps its source's. */
  studioWorldId: string;
  worldMode: 'live' | 'sandbox' | 'replay';
  mechanics: {
    version: 0 | 1;
    requested: boolean;
    tracesEnabled: boolean;
    policy: MechanicsPolicy;
  };
}
export function genomeOf(organism: OrganismRow): {
  pulse: number;
  calm: number;
  grit: number;
  drift: number;
} {
  return { pulse: organism.pulse, calm: organism.calm, grit: organism.grit, drift: organism.drift };
}
export async function loadContext(
  client: pg.PoolClient,
  worldId: string,
  channelId: string,
): Promise<GameContext> {
  const channel = (
    await client.query<
      ChannelRow & {
        studio_world_id: string;
        world_mode: 'live' | 'sandbox' | 'replay';
        rules_canonical: string;
        policy_canonical: string;
        policy_hash: string;
        mechanics_version: 0 | 1;
        mechanics_requested: boolean;
        traces_enabled: boolean;
        resident: OrganismRow | null;
        active_round: RoundRow | null;
        round_organism: OrganismRow | null;
      }
    >({
      name: 'ripple-game-context-v1',
      text: `select c.*,w.mode as world_mode,coalesce(w.replay_of,w.id) as studio_world_id,s.canonical as rules_canonical,
      m.canonical as policy_canonical,wm.policy_hash,p.mechanics_version,p.mechanics_requested,p.traces_enabled,
      to_jsonb(o) as resident,to_jsonb(r) as active_round,to_jsonb(ro) as round_organism
      from channels c join worlds w on w.id=c.world_id join rulesets s on s.hash=c.rules_hash
      join channel_play p on p.world_id=c.world_id and p.channel_id=c.id
      join world_mechanics_policies wm on wm.world_id=c.world_id join mechanics_policies m on m.hash=wm.policy_hash
      left join residencies res on res.world_id=c.world_id and res.channel_id=c.id and res.role='resident' and res.ended_at is null
      left join organisms o on o.world_id=res.world_id and o.id=res.organism_id
      left join rounds r on r.world_id=c.world_id and r.channel_id=c.id and r.completed_at is null and r.kind<>'STUDIO_SELECTION'
      left join organisms ro on ro.world_id=r.world_id and ro.id=r.organism_id
      where c.world_id=$1 and c.id=$2`,
      values: [worldId, channelId],
    })
  ).rows[0];
  if (channel === undefined) throw new Error('Missing locked channel.');
  const rules = storedRules(channel.rules_hash, channel.rules_canonical);
  const policy = storedMechanics(channel.policy_hash, channel.policy_canonical);
  const organism = channel.resident ?? channel.round_organism;
  const round = channel.active_round;
  return {
    client,
    channel,
    organism,
    round,
    rules,
    timings: roundTimingsSchema.parse(channel.configuration),
    studioWorldId: channel.studio_world_id,
    worldMode: channel.world_mode,
    mechanics: {
      version: channel.mechanics_version,
      requested: channel.mechanics_requested,
      tracesEnabled: channel.traces_enabled,
      policy,
    },
  };
}
/** The game clock is held by a manual pause or by an undecided Cocoon Studio. */
export function gameHeld(channel: ChannelRow): boolean {
  return channel.paused || channel.studio_hold;
}
export async function saveCheckpoint(
  context: GameContext,
  checkpoint: RoundCheckpoint,
): Promise<void> {
  if (context.round === null) throw new Error('No round checkpoint to save.');
  await context.client.query(
    'update rounds set phase=$3,checkpoint=$4 where world_id=$1 and id=$2',
    [
      context.channel.world_id,
      context.round.id,
      checkpoint.clock.phase,
      JSON.stringify(checkpoint),
    ],
  );
  context.round = { ...context.round, phase: checkpoint.clock.phase, checkpoint };
}
