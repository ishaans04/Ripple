import { roundTimingsSchema, type RoundTimings } from '@ripple/contracts';
import {
  assertCompatibleRuleset,
  mechanicsPolicyHash,
  mechanicsPolicySchema,
  parseRuleset,
  rulesetHash,
  type CommittedAppearance,
  type MutationSlots,
  type MechanicsPolicy,
  type RoundCheckpoint,
  type Ruleset,
} from '@ripple/engine';
import type pg from 'pg';

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
    await client.query<ChannelRow>('select * from channels where world_id=$1 and id=$2', [
      worldId,
      channelId,
    ])
  ).rows[0];
  if (channel === undefined) throw new Error('Missing locked channel.');
  const world = (
    await client.query<{ studio_world_id: string }>(
      'select coalesce(replay_of,id) as studio_world_id from worlds where id=$1',
      [worldId],
    )
  ).rows[0];
  if (world === undefined) throw new Error('Missing channel world.');
  const stored = (
    await client.query<{ canonical: string }>('select canonical from rulesets where hash=$1', [
      channel.rules_hash,
    ])
  ).rows[0];
  if (stored === undefined) throw new Error('Missing immutable ruleset.');
  const rules = parseRuleset(JSON.parse(stored.canonical));
  assertCompatibleRuleset(rules);
  if (rulesetHash(rules) !== channel.rules_hash) throw new Error('Stored ruleset hash mismatch.');
  const mechanics = (
    await client.query<{
      mechanics_version: 0 | 1;
      mechanics_requested: boolean;
      traces_enabled: boolean;
      policy_hash: string;
      canonical: string;
    }>(
      `select p.mechanics_version,p.mechanics_requested,p.traces_enabled,w.policy_hash,m.canonical
       from channel_play p join world_mechanics_policies w on w.world_id=p.world_id
       join mechanics_policies m on m.hash=w.policy_hash where p.world_id=$1 and p.channel_id=$2`,
      [worldId, channelId],
    )
  ).rows[0];
  if (mechanics === undefined) throw new Error('Missing immutable mechanics policy.');
  const policy = mechanicsPolicySchema.parse(JSON.parse(mechanics.canonical));
  if (mechanicsPolicyHash(policy) !== mechanics.policy_hash)
    throw new Error('Stored mechanics policy hash mismatch.');
  let organism =
    (
      await client.query<OrganismRow>(
        `select o.* from organisms o join residencies r on r.world_id=o.world_id and r.organism_id=o.id
    where r.world_id=$1 and r.channel_id=$2 and r.role='resident' and r.ended_at is null`,
        [worldId, channelId],
      )
    ).rows[0] ?? null;
  const round =
    (
      await client.query<RoundRow>(
        "select * from rounds where world_id=$1 and channel_id=$2 and completed_at is null and kind<>'STUDIO_SELECTION'",
        [worldId, channelId],
      )
    ).rows[0] ?? null;
  if (organism === null && round !== null)
    organism =
      (
        await client.query<OrganismRow>('select * from organisms where world_id=$1 and id=$2', [
          worldId,
          round.organism_id,
        ])
      ).rows[0] ?? null;
  return {
    client,
    channel,
    organism,
    round,
    rules,
    timings: roundTimingsSchema.parse(channel.configuration),
    studioWorldId: world.studio_world_id,
    mechanics: {
      version: mechanics.mechanics_version,
      requested: mechanics.mechanics_requested,
      tracesEnabled: mechanics.traces_enabled,
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
