import { cancelRoundClock } from '@ripple/engine';
import { effect, type CommandEffect } from './lifecycle.ts';
import { saveCheckpoint, type GameContext } from './store.ts';
import type { TraceRow } from './trace-state.ts';

async function clearHostTraces(
  context: GameContext,
  sequence: number,
  atMs: number,
  reason: string,
): Promise<{
  clearedTraceIds: readonly string[];
  cancelledRoundId: string | null;
  modifierRemoved: boolean;
}> {
  const { client, channel, round } = context;
  const rows = (
    await client.query<TraceRow>(
      "select * from habitat_traces where world_id=$1 and channel_id=$2 and status in ('pending','active') order by id",
      [channel.world_id, channel.id],
    )
  ).rows;
  for (const row of rows)
    await client.query(
      "update habitat_traces set status='cleared',remaining_rounds=0,lifetime=$3,decision=$4,version=version+1 where world_id=$1 and id=$2",
      [
        channel.world_id,
        row.id,
        { ...row.lifetime, remainingRounds: 0 },
        { ...row.decision, terminal: { reason, sequence, roundId: round?.id ?? null } },
      ],
    );
  const ids = rows.map((row) => row.id);
  const voting =
    round?.phase === 'VOTING' ||
    (round?.phase === 'INTERRUPTED' && round.checkpoint.clock.interruptedPhase === 'VOTING');
  if (
    round !== null &&
    voting &&
    round.checkpoint.specialBallot?.kind === 'TRACE' &&
    ids.includes(round.checkpoint.specialBallot.traceOffer?.id ?? '')
  ) {
    const checkpoint = {
      ...round.checkpoint,
      clock: cancelRoundClock(round.checkpoint.clock, atMs),
      traceDecisionCancelled: { reason, sequence },
    };
    await client.query(
      "update rounds set phase='COMPLETE',checkpoint=$3,close_sequence=$4,completed_at=$5 where world_id=$1 and id=$2",
      [channel.world_id, round.id, checkpoint, sequence, new Date(atMs)],
    );
    context.round = null;
    return { clearedTraceIds: ids, cancelledRoundId: round.id, modifierRemoved: false };
  }
  const prior = round?.checkpoint.activeTrace;
  const unresolved =
    round !== null &&
    (round.phase === 'VOTING' ||
      round.phase === 'OBSERVING' ||
      (round.phase === 'INTERRUPTED' && round.checkpoint.clock.interruptedPhase !== 'REVEAL'));
  const modifierRemoved = prior !== undefined && prior !== null && unresolved;
  if (modifierRemoved)
    await saveCheckpoint(context, {
      ...round.checkpoint,
      activeTrace: null,
      traceCleared: { id: prior.id, reason, sequence },
    });
  return { clearedTraceIds: ids, cancelledRoundId: null, modifierRemoved };
}
export async function clearHabitatTraces(
  context: GameContext,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const detail = await clearHostTraces(context, sequence, atMs, 'broadcaster-clear');
  const changed =
    detail.clearedTraceIds.length > 0 || detail.modifierRemoved || detail.cancelledRoundId !== null;
  return effect(changed ? 'APPLIED' : 'NO_CHANGE', changed ? 'trace.changed' : null, detail);
}
export async function setHabitatTraces(
  context: GameContext,
  enabled: boolean,
  sequence: number,
  atMs: number,
): Promise<CommandEffect> {
  const changed = enabled !== context.mechanics.tracesEnabled;
  if (changed) {
    await context.client.query(
      'update channel_play set traces_enabled=$3 where world_id=$1 and channel_id=$2',
      [context.channel.world_id, context.channel.id, enabled],
    );
    context.mechanics.tracesEnabled = enabled;
  }
  const cleared = enabled
    ? { clearedTraceIds: [], cancelledRoundId: null, modifierRemoved: false }
    : await clearHostTraces(context, sequence, atMs, 'traces-disabled');
  const applied =
    changed ||
    cleared.clearedTraceIds.length > 0 ||
    cleared.modifierRemoved ||
    cleared.cancelledRoundId !== null;
  return effect(applied ? 'APPLIED' : 'NO_CHANGE', applied ? 'trace.changed' : null, {
    enabled,
    ...cleared,
  });
}
