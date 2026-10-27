import type { GameCommand, GameResultCode } from '@ripple/contracts';
import {
  interruptRoundClock,
  pauseRoundClock,
  recoverRoundClock,
  resumeRoundClock,
} from '@ripple/engine';
import { saveCheckpoint, type GameContext } from './store.ts';

export interface CommandEffect {
  code: GameResultCode;
  updateType: string | null;
  detail: Readonly<Record<string, unknown>>;
}
export function effect(
  code: GameResultCode,
  updateType: string | null = null,
  detail: Readonly<Record<string, unknown>> = {},
): CommandEffect {
  return { code, updateType, detail };
}
export async function applyLifecycle(
  context: GameContext,
  command: Extract<
    GameCommand,
    { type: 'pause' | 'resume' | 'interrupt' | 'recover' | 'integration' }
  >,
  atMs: number,
): Promise<CommandEffect> {
  const { channel, round, client, timings } = context;
  const scope = [channel.world_id, channel.id];
  if (command.type === 'integration') {
    const changed = channel.online !== command.online || channel.healthy !== command.healthy;
    await client.query('update channels set online=$3,healthy=$4 where world_id=$1 and id=$2', [
      ...scope,
      command.online,
      command.healthy,
    ]);
    channel.online = command.online;
    channel.healthy = command.healthy;
    if (round !== null) {
      let clock = round.checkpoint.clock;
      if (!command.healthy) clock = interruptRoundClock(clock, atMs, timings);
      else if (!command.online) clock = pauseRoundClock(clock, atMs);
      // Reconciliation never silently resumes an interrupted or manually paused game.
      if (clock !== round.checkpoint.clock)
        await saveCheckpoint(context, { ...round.checkpoint, clock });
    }
    return effect(changed ? 'APPLIED' : 'NO_CHANGE', changed ? 'integration.status' : null);
  }
  if (command.type === 'pause') {
    if (command.reason === 'manual') {
      await client.query('update channels set paused=true where world_id=$1 and id=$2', scope);
      channel.paused = true;
    }
    if (round === null) return effect('NO_CHANGE');
    const clock = pauseRoundClock(round.checkpoint.clock, atMs);
    if (clock === round.checkpoint.clock) return effect('NO_CHANGE');
    await saveCheckpoint(context, { ...round.checkpoint, clock });
    return effect('APPLIED', 'paused', { reason: command.reason });
  }
  if (command.type === 'interrupt') {
    await client.query('update channels set healthy=false where world_id=$1 and id=$2', scope);
    channel.healthy = false;
    if (round === null) return effect('APPLIED', 'integration.status', { reason: command.reason });
    const clock = interruptRoundClock(round.checkpoint.clock, atMs, timings);
    if (clock === round.checkpoint.clock) return effect('NO_CHANGE');
    await saveCheckpoint(context, { ...round.checkpoint, clock });
    await client.query(`update rounds set confidence='interrupted' where world_id=$1 and id=$2`, [
      channel.world_id,
      round.id,
    ]);
    return effect('APPLIED', 'paused', { reason: command.reason, interrupted: true });
  }
  if (!channel.online || !channel.healthy) return effect('INTEGRATION_UNAVAILABLE');
  if (command.type === 'recover' && channel.paused) return effect('PAUSED');
  if (round === null) return effect('NO_CHANGE');
  const clock =
    command.type === 'recover'
      ? recoverRoundClock(round.checkpoint.clock, atMs)
      : resumeRoundClock(round.checkpoint.clock, atMs);
  if (clock === round.checkpoint.clock) return effect('NO_CHANGE');
  if (command.type === 'resume') {
    await client.query('update channels set paused=false where world_id=$1 and id=$2', scope);
    channel.paused = false;
  }
  await saveCheckpoint(context, { ...round.checkpoint, clock });
  return effect('APPLIED', 'resumed', {
    recovery: command.type === 'recover',
    observationEpoch: clock.observationEpoch,
  });
}
